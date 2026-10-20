CREATE TABLE IF NOT EXISTS stemma_group_avatars (
  group_id BIGINT PRIMARY KEY REFERENCES stemma_groups(id) ON DELETE CASCADE,
  image_data BYTEA NOT NULL,
  image_mime TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT stemma_group_avatar_valid CHECK (
    octet_length(image_data) BETWEEN 1 AND 1048576
    AND image_mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
  )
);
