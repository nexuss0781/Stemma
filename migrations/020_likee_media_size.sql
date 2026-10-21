-- Four minutes at 8 Mbps video plus 256 kbps audio fits within 256 MiB.
-- Keep the existing BYTEA persistence, ownership, and privacy model.
ALTER TABLE stemma_likee_videos DROP CONSTRAINT IF EXISTS stemma_likee_videos_byte_size_check;
ALTER TABLE stemma_likee_videos ADD CONSTRAINT stemma_likee_videos_byte_size_check
  CHECK (byte_size BETWEEN 1 AND 268435456);
