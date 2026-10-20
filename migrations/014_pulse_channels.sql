CREATE TABLE IF NOT EXISTS stemma_pulse_channels (
  id BIGSERIAL PRIMARY KEY,
  owner_subject VARCHAR(255) NOT NULL
    REFERENCES stemma_google_identities (google_subject) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT stemma_pulse_channels_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT stemma_pulse_channels_name_trimmed CHECK (name = btrim(name))
);

CREATE TABLE IF NOT EXISTS stemma_pulse_channel_posts (
  id BIGSERIAL PRIMARY KEY,
  channel_id BIGINT NOT NULL
    REFERENCES stemma_pulse_channels (id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT stemma_pulse_channel_posts_text_length CHECK (char_length(text) BETWEEN 1 AND 4000),
  CONSTRAINT stemma_pulse_channel_posts_text_trimmed CHECK (text = btrim(text))
);

CREATE INDEX IF NOT EXISTS stemma_pulse_channels_updated_idx
  ON stemma_pulse_channels (updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS stemma_pulse_channel_posts_feed_idx
  ON stemma_pulse_channel_posts (channel_id, id DESC);

CREATE OR REPLACE FUNCTION stemma_touch_channel_on_post() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE stemma_pulse_channels SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.channel_id;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS stemma_pulse_channel_post_touch ON stemma_pulse_channel_posts;
CREATE TRIGGER stemma_pulse_channel_post_touch
  AFTER INSERT ON stemma_pulse_channel_posts
  FOR EACH ROW EXECUTE FUNCTION stemma_touch_channel_on_post();
