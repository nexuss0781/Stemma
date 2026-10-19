CREATE TABLE IF NOT EXISTS stemma_pulse_saved_messages (
  id BIGSERIAL PRIMARY KEY,
  google_subject VARCHAR(255) NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT stemma_pulse_saved_messages_nonblank_text
    CHECK (char_length(btrim(text)) > 0 AND char_length(text) <= 4000),
  CONSTRAINT stemma_pulse_saved_messages_google_subject_fk
    FOREIGN KEY (google_subject)
    REFERENCES stemma_google_identities (google_subject)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS stemma_pulse_saved_messages_owner_cursor_idx
  ON stemma_pulse_saved_messages (google_subject, id DESC);
