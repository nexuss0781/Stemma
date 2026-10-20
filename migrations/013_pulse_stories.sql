CREATE TABLE IF NOT EXISTS stemma_pulse_stories (
  id UUID PRIMARY KEY,
  google_subject VARCHAR(255) NOT NULL
    REFERENCES stemma_google_identities (google_subject) ON DELETE CASCADE,
  mime_type TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  data BYTEA NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT stemma_pulse_stories_mime_type_valid
    CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime')),
  CONSTRAINT stemma_pulse_stories_description_valid
    CHECK (char_length(description) <= 1000),
  CONSTRAINT stemma_pulse_stories_attachment_size_valid
    CHECK (byte_size BETWEEN 1 AND 5242880 AND octet_length(data) = byte_size)
);

CREATE OR REPLACE FUNCTION stemma_set_pulse_story_expiry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.expires_at := NEW.created_at + INTERVAL '48 hours';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stemma_pulse_stories_exact_expiry ON stemma_pulse_stories;
CREATE TRIGGER stemma_pulse_stories_exact_expiry
  BEFORE INSERT OR UPDATE ON stemma_pulse_stories
  FOR EACH ROW EXECUTE FUNCTION stemma_set_pulse_story_expiry();

CREATE INDEX IF NOT EXISTS stemma_pulse_stories_feed_idx
  ON stemma_pulse_stories (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS stemma_pulse_stories_owner_active_idx
  ON stemma_pulse_stories (google_subject, expires_at, created_at DESC);
CREATE INDEX IF NOT EXISTS stemma_pulse_stories_expiry_idx
  ON stemma_pulse_stories (expires_at, created_at, id);
