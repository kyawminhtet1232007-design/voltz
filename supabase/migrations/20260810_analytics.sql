-- Visitor analytics for Voltz.
-- Run this in your Supabase dashboard: SQL Editor → New query → paste & run.
--
-- PRIVACY: a "visit" identifies a BROWSER (a random visitor UUID kept in the
-- client's localStorage), not a person. NO IP address is stored here — raw IP
-- lives only in the separate moderation/ban path (ip_blacklist). Clients may
-- INSERT their own visit but may NOT read the table; the owner reads only
-- aggregate counts through the get_site_stats() function below.

CREATE TABLE IF NOT EXISTS site_visits (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  visitor_id  TEXT        NOT NULL,          -- random per-browser UUID (no PII)
  user_id     UUID,                          -- set when the visitor is signed in
  path        TEXT,                          -- page path at time of visit
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS site_visits_visitor_idx ON site_visits (visitor_id);
CREATE INDEX IF NOT EXISTS site_visits_created_idx ON site_visits (created_at);

ALTER TABLE site_visits ENABLE ROW LEVEL SECURITY;

-- Anon may record a visit, but NOT read rows back (prevents scraping the raw
-- visit log / correlating visitor ids). Reads happen only via the aggregate RPC.
CREATE POLICY "Anon insert site_visits"
  ON site_visits FOR INSERT
  WITH CHECK (true);
-- (No SELECT policy on purpose — RLS then denies all client reads.)

-- Aggregate counters only. SECURITY DEFINER so it can read the table under RLS
-- while returning nothing but counts — no raw rows, ids, or PII ever leave the DB.
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
    COUNT(*)                                             AS total_visits,
    COUNT(DISTINCT visitor_id)                           AS unique_visitors,
    COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) AS signed_in_users,
    COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now())) AS visits_today
  FROM site_visits;
$$;

GRANT EXECUTE ON FUNCTION get_site_stats() TO anon, authenticated;

-- NOTE: the get_site_stats() function is readable by anyone with the anon key,
-- but it returns only four aggregate numbers. If you want the counts themselves
-- to be owner-only, move this behind the owner-action Edge Function (see
-- SECURITY.md) — the frontend already PIN-gates the panel that displays them.
