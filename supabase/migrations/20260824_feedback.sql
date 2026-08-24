-- User feedback for Voltz.
-- Run this in your Supabase dashboard: SQL Editor → New query → paste & run.
--
-- PRIVACY: anyone may SUBMIT feedback (anon INSERT) but NOT read the table back.
-- The owner reads recent feedback through get_feedback(), which returns only the
-- type / message / rating / timestamp — never the submitter's user_id (that stays
-- in the row for the owner to map to an account via the Supabase Table editor if
-- they need to follow up). Like get_site_stats(), the RPC is callable with the
-- anon key, so treat the returned messages as owner-visible, not secret.

CREATE TABLE IF NOT EXISTS feedback (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  type        TEXT,                              -- 'idea' | 'bug' | 'praise' | 'other'
  message     TEXT        NOT NULL,
  rating      INT,                               -- optional 1–5 (nullable)
  user_id     UUID,                              -- set when the submitter is signed in
  path        TEXT,                              -- page they were on
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_created_idx ON feedback (created_at DESC);

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

-- Anyone can leave feedback; nobody can read the raw table (no SELECT policy).
CREATE POLICY "Anon insert feedback"
  ON feedback FOR INSERT
  WITH CHECK (true);

-- Owner-facing reader: recent feedback content, newest first. No user_id/PII.
CREATE OR REPLACE FUNCTION get_feedback(lim INT DEFAULT 100)
RETURNS TABLE (id UUID, type TEXT, message TEXT, rating INT, created_at TIMESTAMPTZ)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, type, message, rating, created_at
  FROM feedback
  ORDER BY created_at DESC
  LIMIT GREATEST(1, LEAST(lim, 500));
$$;

GRANT EXECUTE ON FUNCTION get_feedback(INT) TO anon, authenticated;
