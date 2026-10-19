CREATE TABLE IF NOT EXISTS stemma_pulse_attachments (
  id UUID PRIMARY KEY,
  google_subject VARCHAR(255) NOT NULL REFERENCES stemma_google_identities (google_subject) ON DELETE CASCADE,
  chat_message_id BIGINT REFERENCES stemma_direct_chat_messages (id) ON DELETE CASCADE,
  saved_message_id BIGINT REFERENCES stemma_pulse_saved_messages (id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(127) NOT NULL,
  byte_size INTEGER NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT stemma_pulse_attachments_single_message CHECK ((chat_message_id IS NULL) <> (saved_message_id IS NULL)),
  CONSTRAINT stemma_pulse_attachments_name_nonblank CHECK (char_length(btrim(name)) > 0 AND char_length(name) <= 255),
  CONSTRAINT stemma_pulse_attachments_size_valid CHECK (byte_size BETWEEN 1 AND 5242880),
  CONSTRAINT stemma_pulse_attachments_data_size_matches CHECK (octet_length(data) = byte_size),
  CONSTRAINT stemma_pulse_attachments_chat_message_unique UNIQUE (chat_message_id),
  CONSTRAINT stemma_pulse_attachments_saved_message_unique UNIQUE (saved_message_id)
);

CREATE INDEX IF NOT EXISTS stemma_pulse_attachments_owner_idx
  ON stemma_pulse_attachments (google_subject, created_at DESC);
