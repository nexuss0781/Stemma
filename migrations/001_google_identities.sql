CREATE TABLE IF NOT EXISTS stemma_google_identities (
  google_subject VARCHAR(255) PRIMARY KEY,
  verified_email VARCHAR(320) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT stemma_google_identities_email_length
    CHECK (char_length(verified_email) <= 320)
);
