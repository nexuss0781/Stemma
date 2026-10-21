ALTER TABLE stemma_likee_videos DROP CONSTRAINT IF EXISTS stemma_likee_video_mime;
ALTER TABLE stemma_likee_videos ADD CONSTRAINT stemma_likee_video_mime CHECK (
  mime_type IN ('video/mp4', 'video/quicktime', 'video/webm', 'image/jpeg', 'image/png', 'image/webp', 'image/gif')
);
