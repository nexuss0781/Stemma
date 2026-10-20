CREATE UNIQUE INDEX IF NOT EXISTS stemma_pulse_channel_posts_channel_id_unique
  ON stemma_pulse_channel_posts (channel_id, id);

ALTER TABLE stemma_pulse_channels
  ADD COLUMN IF NOT EXISTS pinned_post_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stemma_pulse_channels_pinned_post_fk'
      AND conrelid = 'stemma_pulse_channels'::regclass
  ) THEN
    ALTER TABLE stemma_pulse_channels
      ADD CONSTRAINT stemma_pulse_channels_pinned_post_fk
      FOREIGN KEY (id, pinned_post_id)
      REFERENCES stemma_pulse_channel_posts (channel_id, id)
      ON DELETE SET NULL (pinned_post_id);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS stemma_pulse_channel_subscribers (
  channel_id BIGINT NOT NULL REFERENCES stemma_pulse_channels (id) ON DELETE CASCADE,
  google_subject VARCHAR(255) NOT NULL REFERENCES stemma_google_identities (google_subject) ON DELETE CASCADE,
  muted BOOLEAN NOT NULL DEFAULT FALSE,
  last_read_post_id BIGINT,
  subscribed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel_id, google_subject),
  CONSTRAINT stemma_pulse_channel_subscriber_read_fk
    FOREIGN KEY (channel_id, last_read_post_id)
    REFERENCES stemma_pulse_channel_posts (channel_id, id)
    ON DELETE SET NULL (last_read_post_id)
);

CREATE INDEX IF NOT EXISTS stemma_pulse_channel_subscribers_subject_idx
  ON stemma_pulse_channel_subscribers (google_subject, channel_id);
