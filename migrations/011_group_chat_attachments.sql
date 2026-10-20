ALTER TABLE stemma_pulse_attachments
  ADD COLUMN IF NOT EXISTS group_message_id BIGINT REFERENCES stemma_groups_messages (id) ON DELETE CASCADE;

ALTER TABLE stemma_pulse_attachments
  DROP CONSTRAINT IF EXISTS stemma_pulse_attachments_single_message;

ALTER TABLE stemma_pulse_attachments
  ADD CONSTRAINT stemma_pulse_attachments_single_message
  CHECK (num_nonnulls(chat_message_id, saved_message_id, group_message_id) = 1);

CREATE UNIQUE INDEX IF NOT EXISTS stemma_pulse_attachments_group_message_unique_idx
  ON stemma_pulse_attachments (group_message_id) WHERE group_message_id IS NOT NULL;

