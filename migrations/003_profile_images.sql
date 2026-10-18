ALTER TABLE stemma_student_profiles
  ADD COLUMN IF NOT EXISTS profile_image BYTEA NULL,
  ADD COLUMN IF NOT EXISTS profile_image_mime TEXT NULL,
  ADD COLUMN IF NOT EXISTS profile_image_width INTEGER NULL,
  ADD COLUMN IF NOT EXISTS profile_image_height INTEGER NULL;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stemma_student_profiles_profile_image_valid'
      AND conrelid = 'stemma_student_profiles'::regclass
  ) THEN
    ALTER TABLE stemma_student_profiles
      ADD CONSTRAINT stemma_student_profiles_profile_image_valid CHECK (
        (profile_image IS NULL AND profile_image_mime IS NULL AND profile_image_width IS NULL AND profile_image_height IS NULL)
        OR
        (profile_image IS NOT NULL
          AND octet_length(profile_image) BETWEEN 1 AND 1048576
          AND profile_image_mime IS NOT NULL
          AND profile_image_mime IN ('image/png', 'image/jpeg', 'image/webp')
          AND profile_image_width IS NOT NULL
          AND profile_image_height IS NOT NULL
          AND profile_image_width BETWEEN 1 AND 2048
          AND profile_image_height BETWEEN 1 AND 2048
          AND profile_image_width::BIGINT * profile_image_height::BIGINT <= 4194304)
      );
  END IF;
END
$migration$;
