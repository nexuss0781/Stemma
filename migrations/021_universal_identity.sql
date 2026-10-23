-- Universal identity v1. This file is run inside a transaction serialized by
-- createUniversalIdentityStore.migrate() using a PostgreSQL advisory xact lock.
-- Claims are retained when an entity is deleted (tombstones reserve names), but
-- resolution checks the entity still exists, so a deleted entity never resolves.

CREATE TABLE IF NOT EXISTS stemma_universal_identities (
  identity_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('account', 'group', 'channel', 'system_app')),
  entity_key TEXT NOT NULL,
  username TEXT NOT NULL CHECK (username ~ '^[a-z0-9_.-]{5,40}$'),
  display_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (entity_type, entity_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS stemma_universal_identity_username_ci_uq
  ON stemma_universal_identities (lower(username));

ALTER TABLE stemma_pulse_channels ADD COLUMN IF NOT EXISTS username VARCHAR(40);
LOCK TABLE stemma_google_identities, stemma_student_profiles, stemma_groups,
  stemma_pulse_channels IN SHARE ROW EXCLUSIVE MODE;

-- Normalize legacy handles. Short or malformed legacy handles are replaced by
-- stable, readable fallbacks rather than leaking database IDs into public names.
-- Case-insensitive collisions among valid legacy handles are rejected below;
-- no owner is selected implicitly when existing users chose the same handle.
DO $$
DECLARE collisions text;
BEGIN
  SELECT string_agg(format('%s (%s): %s', kind, folded, labels), E'\n' ORDER BY kind, folded)
    INTO collisions
  FROM (
    SELECT lower(handle) AS folded,
           string_agg(format('%s %s', kind, label), ', ' ORDER BY kind, label) AS labels,
           string_agg(DISTINCT kind, '/') AS kind
    FROM (
      SELECT 'account' AS kind, gi.google_subject AS label,
        CASE WHEN lower(btrim(p.username)) ~ '^[a-z0-9_.-]{5,40}$' THEN lower(btrim(p.username))
          ELSE 'user_' || substr(md5(gi.google_subject), 1, 10) END AS handle
      FROM stemma_google_identities gi LEFT JOIN stemma_student_profiles p ON p.google_subject = gi.google_subject
      UNION ALL
      SELECT 'group', g.id::text,
        CASE WHEN lower(btrim(g.slug)) ~ '^[a-z0-9_-]{5,40}$' THEN lower(btrim(g.slug))
          ELSE 'group-' || g.id::text END
      FROM stemma_groups g
      UNION ALL
      SELECT 'channel', c.id::text,
        CASE WHEN lower(btrim(c.username)) ~ '^[a-z0-9_.-]{5,40}$' THEN lower(btrim(c.username))
          ELSE 'channel-' || c.id::text END
      FROM stemma_pulse_channels c
    ) handles
    GROUP BY lower(handle)
    HAVING count(*) > 1
  ) duplicate_handles;
  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION 'Universal identity migration stopped: legacy handles collide case-insensitively. Resolve these explicitly before retrying; no handles were changed: %', collisions
      USING ERRCODE = '23505', HINT = 'Review the listed account usernames and group slugs, choose explicit new handles for one owner in each collision, then rerun the migration.';
  END IF;
END $$;

UPDATE stemma_student_profiles p SET username = CASE
  WHEN lower(btrim(p.username)) ~ '^[a-z0-9_.-]{5,40}$' THEN lower(btrim(p.username))
  ELSE 'user_' || substr(md5(p.google_subject), 1, 10) END
WHERE p.username IS DISTINCT FROM CASE
  WHEN lower(btrim(p.username)) ~ '^[a-z0-9_.-]{5,40}$' THEN lower(btrim(p.username))
  ELSE 'user_' || substr(md5(p.google_subject), 1, 10) END;
UPDATE stemma_groups g SET slug = CASE
  WHEN lower(btrim(g.slug)) ~ '^[a-z0-9_-]{5,40}$' THEN lower(btrim(g.slug))
  ELSE 'group-' || g.id::text END
WHERE g.slug IS DISTINCT FROM CASE
  WHEN lower(btrim(g.slug)) ~ '^[a-z0-9_-]{5,40}$' THEN lower(btrim(g.slug))
  ELSE 'group-' || g.id::text END;
UPDATE stemma_pulse_channels c SET username = 'channel-' || c.id::text
WHERE c.username IS NULL OR lower(btrim(c.username)) !~ '^[a-z0-9_.-]{5,40}$';
UPDATE stemma_pulse_channels SET username = lower(btrim(username))
WHERE username IS DISTINCT FROM lower(btrim(username));
ALTER TABLE stemma_pulse_channels ALTER COLUMN username SET NOT NULL;

CREATE OR REPLACE FUNCTION stemma_claim_universal_identity(p_type TEXT, p_key TEXT, p_username TEXT, p_name TEXT)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE claimed UUID; canonical TEXT;
BEGIN
  canonical := lower(btrim(COALESCE(p_username, '')));
  IF p_type NOT IN ('account', 'group', 'channel', 'system_app') OR canonical !~ '^[a-z0-9_.-]{5,40}$' THEN
    RAISE EXCEPTION 'Invalid universal username.' USING ERRCODE = '23514';
  END IF;
  INSERT INTO stemma_universal_identities (entity_type, entity_key, username, display_name)
    VALUES (p_type, p_key, canonical, COALESCE(p_name, ''))
  ON CONFLICT (entity_type, entity_key) DO UPDATE
    SET username = EXCLUDED.username, display_name = EXCLUDED.display_name, updated_at = CURRENT_TIMESTAMP
  RETURNING identity_id INTO claimed;
  RETURN claimed;
END $$;

CREATE OR REPLACE FUNCTION stemma_sync_profile_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE chosen TEXT;
BEGIN
  SELECT username INTO chosen FROM stemma_universal_identities
    WHERE entity_type = 'account' AND entity_key = NEW.google_subject;
  IF NEW.username IS NULL OR btrim(NEW.username) = '' THEN
    NEW.username := COALESCE(chosen, 'user_' || substr(md5(NEW.google_subject), 1, 10));
  ELSE
    NEW.username := lower(btrim(NEW.username));
  END IF;
  PERFORM stemma_claim_universal_identity('account', NEW.google_subject, NEW.username, COALESCE(NEW.nick_name, ''));
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION stemma_sync_google_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO stemma_universal_identities (entity_type, entity_key, username, display_name)
  VALUES ('account', NEW.google_subject, 'user_' || substr(md5(NEW.google_subject), 1, 10), '')
  ON CONFLICT (entity_type, entity_key) DO NOTHING;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION stemma_sync_group_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.slug := lower(btrim(NEW.slug));
  PERFORM stemma_claim_universal_identity('group', NEW.id::text, NEW.slug, NEW.name);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION stemma_sync_channel_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.username IS NULL OR btrim(NEW.username) = '' THEN NEW.username := 'channel-' || NEW.id::text; END IF;
  NEW.username := lower(btrim(NEW.username));
  PERFORM stemma_claim_universal_identity('channel', NEW.id::text, NEW.username, NEW.name);
  RETURN NEW;
END $$;

-- Existing-account backfill is also safe on every startup: entity-key conflicts
-- update the existing claim without changing its immutable UUID.
INSERT INTO stemma_universal_identities (entity_type, entity_key, username, display_name)
SELECT 'account', gi.google_subject,
       COALESCE(NULLIF(btrim(p.username), ''), 'user_' || substr(md5(gi.google_subject), 1, 10)),
       COALESCE(NULLIF(btrim(p.nick_name), ''), '')
FROM stemma_google_identities gi LEFT JOIN stemma_student_profiles p ON p.google_subject = gi.google_subject
ON CONFLICT (entity_type, entity_key) DO UPDATE SET
  username = EXCLUDED.username, display_name = EXCLUDED.display_name, updated_at = CURRENT_TIMESTAMP;
INSERT INTO stemma_universal_identities (entity_type, entity_key, username, display_name)
SELECT 'group', id::text, slug, name FROM stemma_groups
ON CONFLICT (entity_type, entity_key) DO UPDATE SET
  username = EXCLUDED.username, display_name = EXCLUDED.display_name, updated_at = CURRENT_TIMESTAMP;
INSERT INTO stemma_universal_identities (entity_type, entity_key, username, display_name)
SELECT 'channel', id::text, username, name FROM stemma_pulse_channels
ON CONFLICT (entity_type, entity_key) DO UPDATE SET
  username = EXCLUDED.username, display_name = EXCLUDED.display_name, updated_at = CURRENT_TIMESTAMP;

DROP TRIGGER IF EXISTS stemma_universal_profile_identity ON stemma_student_profiles;
CREATE TRIGGER stemma_universal_profile_identity BEFORE INSERT OR UPDATE OF username, nick_name ON stemma_student_profiles
  FOR EACH ROW EXECUTE FUNCTION stemma_sync_profile_identity();
DROP TRIGGER IF EXISTS stemma_universal_google_identity ON stemma_google_identities;
CREATE TRIGGER stemma_universal_google_identity AFTER INSERT ON stemma_google_identities
  FOR EACH ROW EXECUTE FUNCTION stemma_sync_google_identity();
DROP TRIGGER IF EXISTS stemma_universal_group_identity ON stemma_groups;
CREATE TRIGGER stemma_universal_group_identity BEFORE INSERT OR UPDATE OF slug, name ON stemma_groups
  FOR EACH ROW EXECUTE FUNCTION stemma_sync_group_identity();
DROP TRIGGER IF EXISTS stemma_universal_channel_identity ON stemma_pulse_channels;
CREATE TRIGGER stemma_universal_channel_identity BEFORE INSERT OR UPDATE OF username, name ON stemma_pulse_channels
  FOR EACH ROW EXECUTE FUNCTION stemma_sync_channel_identity();

CREATE OR REPLACE FUNCTION stemma_universal_identity_immutable_uuid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.identity_id IS DISTINCT FROM OLD.identity_id OR NEW.entity_type IS DISTINCT FROM OLD.entity_type OR NEW.entity_key IS DISTINCT FROM OLD.entity_key THEN
    RAISE EXCEPTION 'Universal identity UUID and owner are immutable.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS stemma_universal_identity_immutable ON stemma_universal_identities;
CREATE TRIGGER stemma_universal_identity_immutable BEFORE UPDATE ON stemma_universal_identities
  FOR EACH ROW EXECUTE FUNCTION stemma_universal_identity_immutable_uuid();
