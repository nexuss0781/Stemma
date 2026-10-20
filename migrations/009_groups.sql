CREATE TABLE IF NOT EXISTS stemma_groups (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug VARCHAR(40) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility VARCHAR(10) NOT NULL,
  owner_subject VARCHAR(255) NOT NULL REFERENCES stemma_google_identities(google_subject) ON DELETE CASCADE,
  invite_token VARCHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT stemma_groups_name_valid CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT stemma_groups_slug_valid CHECK (slug ~ '^[A-Za-z0-9_-]{3,40}$'),
  CONSTRAINT stemma_groups_description_valid CHECK (char_length(description) <= 500),
  CONSTRAINT stemma_groups_visibility_valid CHECK (visibility IN ('public', 'private')),
  CONSTRAINT stemma_groups_invite_token_valid CHECK (invite_token ~ '^[A-Za-z0-9_-]{40,64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS stemma_groups_slug_ci_unique_idx ON stemma_groups (lower(slug));
CREATE INDEX IF NOT EXISTS stemma_groups_public_name_idx ON stemma_groups (lower(name), id) WHERE visibility = 'public';

CREATE TABLE IF NOT EXISTS stemma_groups_memberships (
  id BIGSERIAL PRIMARY KEY,
  group_id BIGINT NOT NULL REFERENCES stemma_groups(id) ON DELETE CASCADE,
  member_subject VARCHAR(255) NOT NULL REFERENCES stemma_google_identities(google_subject) ON DELETE CASCADE,
  role VARCHAR(10) NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT stemma_groups_membership_role_valid CHECK (role IN ('owner', 'member')),
  CONSTRAINT stemma_groups_membership_unique UNIQUE (group_id, member_subject)
);
CREATE UNIQUE INDEX IF NOT EXISTS stemma_groups_one_owner_idx ON stemma_groups_memberships (group_id) WHERE role = 'owner';
CREATE INDEX IF NOT EXISTS stemma_groups_membership_user_idx ON stemma_groups_memberships (member_subject, group_id);
CREATE INDEX IF NOT EXISTS stemma_groups_membership_order_idx ON stemma_groups_memberships (group_id, joined_at, id);

CREATE TABLE IF NOT EXISTS stemma_groups_messages (
  id BIGSERIAL PRIMARY KEY,
  group_id BIGINT NOT NULL REFERENCES stemma_groups(id) ON DELETE CASCADE,
  author_subject VARCHAR(255) NOT NULL REFERENCES stemma_google_identities(google_subject) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT stemma_groups_message_nonblank CHECK (char_length(btrim(text)) > 0 AND char_length(text) <= 4000)
);
CREATE INDEX IF NOT EXISTS stemma_groups_messages_cursor_idx ON stemma_groups_messages (group_id, id DESC);
