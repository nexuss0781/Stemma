CREATE TABLE IF NOT EXISTS stemma_student_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_subject VARCHAR(255) NOT NULL,
  notification_key TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at TIMESTAMPTZ,
  CONSTRAINT stemma_student_notifications_key_length CHECK (char_length(notification_key) BETWEEN 1 AND 100),
  CONSTRAINT stemma_student_notifications_title_length CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT stemma_student_notifications_message_length CHECK (char_length(message) BETWEEN 1 AND 4000),
  CONSTRAINT stemma_student_notifications_read_after_create CHECK (read_at IS NULL OR read_at >= created_at),
  CONSTRAINT stemma_student_notifications_subject_key UNIQUE (google_subject, notification_key)
);

CREATE INDEX IF NOT EXISTS stemma_student_notifications_subject_created
  ON stemma_student_notifications (google_subject, created_at DESC, id DESC);

INSERT INTO stemma_student_notifications (google_subject, notification_key, title, message)
SELECT google_subject,
       'app-welcome-v1',
       'Welcome to Stemma',
       'Welcome to Stemma! We’re glad you’re here. This app brings your payment tools, transaction history, and profile together in one place. You can explore the payment area, review the history available for your account, and update your profile details whenever you like. Please remember that payment examples in this demo do not move real money. This welcome note does not add any sample or past transactions to your history. We hope you enjoy getting familiar with the app.'
FROM stemma_google_identities
ON CONFLICT (google_subject, notification_key) DO NOTHING;
