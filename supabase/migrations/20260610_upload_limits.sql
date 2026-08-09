-- Upload limits for chat-media
-- Run this in your Supabase dashboard: SQL Editor → New query → paste & run

-- Cap the chat-media bucket at 40MB per file (server-side enforcement)
UPDATE storage.buckets SET file_size_limit = 41943040 WHERE id = 'chat-media';

-- Per-user daily upload usage tracking (40MB/day cap, enforced client-side)
CREATE TABLE IF NOT EXISTS upload_usage (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  username    TEXT        NOT NULL,
  upload_date DATE        NOT NULL DEFAULT CURRENT_DATE,
  bytes_used  BIGINT      NOT NULL DEFAULT 0,
  UNIQUE (username, upload_date)
);

ALTER TABLE upload_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read upload_usage"
  ON upload_usage FOR SELECT
  USING (true);

CREATE POLICY "Public insert upload_usage"
  ON upload_usage FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Public update upload_usage"
  ON upload_usage FOR UPDATE
  USING (true);
