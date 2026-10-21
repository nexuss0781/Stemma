CREATE TABLE IF NOT EXISTS stemma_likee_videos (
  id UUID PRIMARY KEY,
  google_subject VARCHAR(255) NOT NULL REFERENCES stemma_google_identities(google_subject) ON DELETE CASCADE,
  caption TEXT NOT NULL DEFAULT '',
  mime_type VARCHAR(64) NOT NULL,
  data BYTEA NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT stemma_likee_caption_length CHECK (char_length(caption) <= 1000),
  CONSTRAINT stemma_likee_video_mime CHECK (mime_type IN ('video/mp4', 'video/quicktime', 'video/webm'))
);
CREATE INDEX IF NOT EXISTS stemma_likee_videos_feed_idx ON stemma_likee_videos (created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS stemma_likee_comments (
  id BIGSERIAL PRIMARY KEY,
  video_id UUID NOT NULL REFERENCES stemma_likee_videos(id) ON DELETE CASCADE,
  google_subject VARCHAR(255) NOT NULL REFERENCES stemma_google_identities(google_subject) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (char_length(btrim(text)) BETWEEN 1 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS stemma_likee_comments_video_idx ON stemma_likee_comments (video_id, id DESC);
CREATE TABLE IF NOT EXISTS stemma_likee_reactions (
  video_id UUID NOT NULL REFERENCES stemma_likee_videos(id) ON DELETE CASCADE,
  google_subject VARCHAR(255) NOT NULL REFERENCES stemma_google_identities(google_subject) ON DELETE CASCADE,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('like', 'repost', 'bookmark')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (video_id, google_subject, kind)
);
CREATE INDEX IF NOT EXISTS stemma_likee_reactions_count_idx ON stemma_likee_reactions (video_id, kind);
CREATE TABLE IF NOT EXISTS stemma_likee_follows (
  follower_subject VARCHAR(255) NOT NULL REFERENCES stemma_google_identities(google_subject) ON DELETE CASCADE,
  creator_subject VARCHAR(255) NOT NULL REFERENCES stemma_google_identities(google_subject) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (follower_subject, creator_subject),
  CONSTRAINT stemma_likee_follow_not_self CHECK (follower_subject <> creator_subject)
);
CREATE TABLE IF NOT EXISTS stemma_likee_share_requests (
  google_subject VARCHAR(255) NOT NULL REFERENCES stemma_google_identities(google_subject) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  video_id UUID NOT NULL REFERENCES stemma_likee_videos(id) ON DELETE CASCADE,
  conversation_ids BIGINT[] NOT NULL CHECK (cardinality(conversation_ids) BETWEEN 1 AND 25),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (google_subject, request_id)
);
