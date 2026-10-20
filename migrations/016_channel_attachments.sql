ALTER TABLE stemma_pulse_attachments
  ADD COLUMN IF NOT EXISTS channel_post_id BIGINT
    REFERENCES stemma_pulse_channel_posts (id) ON DELETE CASCADE;

ALTER TABLE stemma_pulse_attachments
  DROP CONSTRAINT IF EXISTS stemma_pulse_attachments_single_message;

ALTER TABLE stemma_pulse_attachments
  ADD CONSTRAINT stemma_pulse_attachments_single_message
  CHECK (num_nonnulls(chat_message_id, saved_message_id, group_message_id, channel_post_id) = 1);

CREATE UNIQUE INDEX IF NOT EXISTS stemma_pulse_attachments_channel_post_unique_idx
  ON stemma_pulse_attachments (channel_post_id) WHERE channel_post_id IS NOT NULL;
