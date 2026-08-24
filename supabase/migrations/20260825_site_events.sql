-- Combine site_visits + feedback into ONE table (site_events), discriminated by
-- `kind`. Run this in your Supabase dashboard: SQL Editor -> New query -> paste & run.
-- Safe to run even if you already applied 20260810_analytics.sql / 20260824_feedback.sql
-- -- this migrates their data across, then drops the two old tables.
--
-- PRIVACY (unchanged from the split tables): visitor_id is a random per-browser
-- UUID, not a person; NO IP address is stored. Clients may INSERT their own rows
-- but may NOT read the table -- the owner reads only aggregates/content through
-- the two SECURITY DEFINER functions below (get_site_stats, get_feedback).

CREATE TABLE IF NOT EXISTS site_events (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  kind        TEXT        NOT NULL CHECK (kind IN ('visit', 'feedback')),
  visitor_id  TEXT,                              -- visits: random per-browser UUID
  user_id     UUID,                              -- both: set when signed in
  path        TEXT,                              -- both: page path at the time
  type        TEXT,                              -- feedback: idea/bug/praise/other
  message     TEXT,                              -- feedback: the message body
  rating      INT,                                -- feedback: optional rating
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS site_events_kind_created_idx ON site_events (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS site_events_visitor_idx       ON site_events (visitor_id);

-- Migrate existing rows across (no-ops if those tables don't exist / are empty).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'site_visits') THEN
    INSERT INTO site_events (kind, visitor_id, user_id, path, created_at)
    SELECT 'visit', visitor_id, user_id, path, created_at FROM site_visits;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'feedback') THEN
    INSERT INTO site_events (kind, type, message, rating, user_id, path, created_at)
    SELECT 'feedback', type, message, rating, user_id, path, created_at FROM feedback;
  END IF;
END $$;

DROP TABLE IF EXISTS site_visits;
DROP TABLE IF EXISTS feedback;

ALTER TABLE site_events ENABLE ROW LEVEL SECURITY;

-- Anon may record their own visit/feedback row, but NOT read rows back.
-- (No SELECT policy on purpose -- RLS then denies all client reads.)
CREATE POLICY "Anon insert site_events"
  ON site_events FOR INSERT
  WITH CHECK (true);

-- Aggregate counters only -- same shape/contract as the old get_site_stats().
CREATE OR REPLACE FUNCTION get_site_stats()
RETURNS TABLE (
  total_visits     BIGINT,
  unique_visitors  BIGINT,
  signed_in_users  BIGINT,
  visits_today     BIGINT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COUNT(*)                                                    AS total_visits,
    COUNT(DISTINCT visitor_id)                                  AS unique_visitors,
    COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)  AS signed_in_users,
    COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now())) AS visits_today
  FROM site_events
  WHERE kind = 'visit';
$$;

-- Recent feedback content only (no user_id/PII) -- same shape/contract as before.
CREATE OR REPLACE FUNCTION get_feedback(lim INT DEFAULT 100)
RETURNS TABLE (id UUID, type TEXT, message TEXT, rating INT, created_at TIMESTAMPTZ)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, type, message, rating, created_at
  FROM site_events
  WHERE kind = 'feedback'
  ORDER BY created_at DESC
  LIMIT GREATEST(1, LEAST(lim, 500));
$$;

GRANT EXECUTE ON FUNCTION get_site_stats() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_feedback(INT) TO anon, authenticated;
