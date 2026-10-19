CREATE TABLE IF NOT EXISTS stemma_direct_chat_conversations (
  id BIGSERIAL PRIMARY KEY,
  participant_a VARCHAR(255) NOT NULL,
  participant_b VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT stemma_direct_chat_distinct_participants CHECK (participant_a < participant_b),
  CONSTRAINT stemma_direct_chat_participant_a_fk FOREIGN KEY (participant_a)
    REFERENCES stemma_google_identities (google_subject) ON DELETE CASCADE,
  CONSTRAINT stemma_direct_chat_participant_b_fk FOREIGN KEY (participant_b)
    REFERENCES stemma_google_identities (google_subject) ON DELETE CASCADE,
  CONSTRAINT stemma_direct_chat_pair_unique UNIQUE (participant_a, participant_b)
);

CREATE TABLE IF NOT EXISTS stemma_direct_chat_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES stemma_direct_chat_conversations(id) ON DELETE CASCADE,
  author_subject VARCHAR(255) NOT NULL REFERENCES stemma_google_identities(google_subject) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT stemma_direct_chat_message_nonblank CHECK (char_length(btrim(text)) > 0 AND char_length(text) <= 4000)
);

CREATE INDEX IF NOT EXISTS stemma_direct_chat_messages_conversation_cursor_idx
  ON stemma_direct_chat_messages (conversation_id, id DESC);
CREATE INDEX IF NOT EXISTS stemma_direct_chat_conversations_participant_a_idx
  ON stemma_direct_chat_conversations (participant_a, id DESC);
CREATE INDEX IF NOT EXISTS stemma_direct_chat_conversations_participant_b_idx
  ON stemma_direct_chat_conversations (participant_b, id DESC);
