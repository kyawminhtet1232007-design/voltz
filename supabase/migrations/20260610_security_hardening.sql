-- ── Security hardening ───────────────────────────────────────────────────────
-- APPLY ONLY AFTER deploying the `owner-action` Edge Function AND switching the
-- frontend to call it for IP bans / automod writes. Applying this BEFORE that
-- rewire will break the in-app ban & automod controls (they currently write
-- directly with the anon key).
--
-- Why: the public anon key is shipped in the browser bundle, so any
-- `WITH CHECK (true)` write policy is effectively world-writable. These policies
-- move authority for privileged writes to the service role (used only inside the
-- owner-action Edge Function), while keeping public READ so the client guards
-- still work.

-- ip_blacklist: public can READ (to enforce bans client-side), but only the
-- service role may INSERT/DELETE. Drop the permissive owner policies.
DROP POLICY IF EXISTS "Owner insert ip_blacklist" ON ip_blacklist;
DROP POLICY IF EXISTS "Owner delete ip_blacklist" ON ip_blacklist;
-- (No replacement INSERT/DELETE policy for anon => denied by default. The
--  service role bypasses RLS entirely, so the Edge Function still works.)

-- upload_usage: public can READ + INSERT/UPDATE their own running total is
-- needed for the client quota check, but UPDATE should not let a user shrink
-- their own counter to dodge the cap. Tighten UPDATE to forbid lowering the
-- value (best-effort; authoritative accounting should move server-side later).
DROP POLICY IF EXISTS "Public update upload_usage" ON upload_usage;
CREATE POLICY "No-decrease update upload_usage"
  ON upload_usage FOR UPDATE
  USING (true)
  WITH CHECK (bytes_used >= (SELECT bytes_used FROM upload_usage u WHERE u.id = upload_usage.id));

-- NOTE on admin-role spoofing (server_config records in the messages table):
-- A full fix requires authenticated identities. Until then, treat `isAdmin` in
-- the client as advisory. Consider migrating server/admin config out of the
-- shared `messages` table into a dedicated table whose writes are also gated by
-- the owner-action Edge Function.
