-- IP Blacklist table for automod
-- Run this in your Supabase dashboard: SQL Editor → New query → paste & run

CREATE TABLE IF NOT EXISTS ip_blacklist (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  ip         TEXT        NOT NULL UNIQUE,
  username   TEXT,
  banned_at  TIMESTAMPTZ DEFAULT now(),
  banned_by  TEXT        DEFAULT 'OWNER'
);

-- Row Level Security
ALTER TABLE ip_blacklist ENABLE ROW LEVEL SECURITY;

-- Anyone can read (needed so the client-side check works for all visitors)
CREATE POLICY "Public read ip_blacklist"
  ON ip_blacklist FOR SELECT
  USING (true);

-- Anon key can insert and delete (access is gated by the owner PIN in the frontend)
CREATE POLICY "Owner insert ip_blacklist"
  ON ip_blacklist FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Owner delete ip_blacklist"
  ON ip_blacklist FOR DELETE
  USING (true);

-- Enable Realtime so bans propagate instantly to all connected sessions
ALTER PUBLICATION supabase_realtime ADD TABLE ip_blacklist;
