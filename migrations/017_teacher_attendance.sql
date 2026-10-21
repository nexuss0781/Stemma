CREATE TABLE IF NOT EXISTS stemma_teacher_attendance_students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_subject VARCHAR(255) NOT NULL
    REFERENCES stemma_google_identities (google_subject) ON DELETE CASCADE,
  roster_position BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  normalized_name TEXT NOT NULL CHECK (char_length(normalized_name) BETWEEN 1 AND 120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT stemma_teacher_attendance_students_owner_name_unique
    UNIQUE (google_subject, normalized_name),
  CONSTRAINT stemma_teacher_attendance_students_owner_id_unique
    UNIQUE (google_subject, id)
);

CREATE TABLE IF NOT EXISTS stemma_teacher_attendance_snapshots (
  google_subject VARCHAR(255) NOT NULL
    REFERENCES stemma_google_identities (google_subject) ON DELETE CASCADE,
  attendance_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT stemma_teacher_attendance_snapshots_pk
    PRIMARY KEY (google_subject, attendance_date)
);

CREATE TABLE IF NOT EXISTS stemma_teacher_attendance_days (
  google_subject VARCHAR(255) NOT NULL,
  attendance_date DATE NOT NULL,
  student_id UUID NOT NULL,
  CONSTRAINT stemma_teacher_attendance_days_pk
    PRIMARY KEY (google_subject, attendance_date, student_id),
  CONSTRAINT stemma_teacher_attendance_days_snapshot_fk
    FOREIGN KEY (google_subject, attendance_date)
    REFERENCES stemma_teacher_attendance_snapshots (google_subject, attendance_date)
    ON DELETE CASCADE,
  CONSTRAINT stemma_teacher_attendance_days_owner_student_fk
    FOREIGN KEY (google_subject, student_id)
    REFERENCES stemma_teacher_attendance_students (google_subject, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS stemma_teacher_attendance_days_by_date_idx
  ON stemma_teacher_attendance_days (google_subject, attendance_date);
