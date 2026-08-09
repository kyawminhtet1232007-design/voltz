// ── owner-action Edge Function ───────────────────────────────────────────────
// Server-side authority for privileged owner/admin operations (IP bans, automod
// rule writes). This closes the hole where the public anon key let ANY client
// call the Supabase REST API directly to ban IPs or edit automod rules — the
// frontend PIN check was UI-only and not a real boundary.
//
// How it works:
//   1. The frontend sends the owner PIN + the requested action to this function.
//   2. This function verifies the PIN against OWNER_PIN_HASH (a secret env var,
//      NOT the public VITE_OWNER_PIN_HASH) using SHA-256.
//   3. On success it performs the write using the SERVICE ROLE key, which
//      bypasses RLS. The service key NEVER reaches the browser.
//
// Deploy:
//   supabase functions deploy owner-action
//   supabase secrets set OWNER_PIN_HASH=<sha256 of the PIN> \
//                        SERVICE_ROLE_KEY=<your service_role key> \
//                        SUPABASE_URL=<your project url>
//
// After deploying AND switching the frontend to call this function, apply
// supabase/migrations/20260610_security_hardening.sql to lock down direct writes.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const { pin, action, payload } = await req.json();

    // 1. Verify the owner PIN server-side.
    const expected = Deno.env.get("OWNER_PIN_HASH");
    if (!expected) return json({ error: "Server not configured (OWNER_PIN_HASH missing)" }, 500);
    if (!pin || (await sha256Hex(String(pin))) !== expected) {
      return json({ error: "Unauthorized" }, 401);
    }

    // 2. Privileged client (service role bypasses RLS).
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SERVICE_ROLE_KEY")!,
    );

    // 3. Dispatch the requested action. Whitelist only — never eval arbitrary SQL.
    switch (action) {
      case "ban_ip": {
        const { ip, username } = payload ?? {};
        if (!ip) return json({ error: "ip required" }, 400);
        const { error } = await sb.from("ip_blacklist")
          .insert({ ip, username: username ?? null, banned_by: "OWNER" });
        if (error && error.code !== "23505") return json({ error: error.message }, 400); // ignore dupes
        return json({ ok: true });
      }
      case "unban_ip": {
        const { ip } = payload ?? {};
        if (!ip) return json({ error: "ip required" }, 400);
        const { error } = await sb.from("ip_blacklist").delete().eq("ip", ip);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }
      case "save_automod": {
        const { serverId, rules, username, color } = payload ?? {};
        if (!serverId || !Array.isArray(rules)) return json({ error: "serverId + rules required" }, 400);
        const { error } = await sb.from("messages").insert({
          channel: `${serverId}_sys`, username: username ?? "OWNER", color: color ?? "#3b82f6",
          content: null, share_type: "automod_config", share_data: { rules },
        });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }
      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    return json({ error: `Bad request: ${(err as Error).message}` }, 400);
  }
});
