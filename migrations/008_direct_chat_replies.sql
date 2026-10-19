ALTER TABLE stemma_direct_chat_messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id BIGINT;

-- Deliberately do not add a foreign key: a reply must retain the referenced ID
-- if the original message is later deleted, so clients can show an unavailable
-- reply preview. The write path validates that references belong to this chat.
CREATE INDEX IF NOT EXISTS stemma_direct_chat_messages_reply_idx
  ON stemma_direct_chat_messages (reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;
