CREATE TABLE IF NOT EXISTS stemma_student_profiles (
  google_subject VARCHAR(255) PRIMARY KEY,
  first_name VARCHAR(80) NOT NULL,
  middle_name VARCHAR(80) NOT NULL DEFAULT '',
  last_name VARCHAR(80) NOT NULL,
  student_id VARCHAR(64) NOT NULL,
  department VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT stemma_student_profiles_google_subject_fk
    FOREIGN KEY (google_subject)
    REFERENCES stemma_google_identities (google_subject)
    ON DELETE CASCADE,
  CONSTRAINT stemma_student_profiles_nonempty_required_fields
    CHECK (char_length(btrim(first_name)) > 0 AND char_length(btrim(last_name)) > 0
       AND char_length(btrim(student_id)) > 0 AND char_length(btrim(department)) > 0)
);
