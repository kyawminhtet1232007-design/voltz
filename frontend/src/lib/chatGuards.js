// ── chatGuards.js ────────────────────────────────────────────────────────────
// Pure, side-effect-free guard logic for the Team Chat. Extracted from the
// TeamChat component so the security-relevant rules (automod matching, rate
// limiting, daily upload accounting, IP ban checks) can be unit-tested in
// isolation and reused.
//
// IMPORTANT: these are CLIENT-SIDE guards for UX. They are NOT a security
// boundary on their own — the authoritative enforcement must live in Supabase
// RLS / Postgres functions (see supabase/migrations/20260610_security_hardening.sql).
// Keeping them pure here at least makes the client behaviour predictable & tested.

export const MAX_FILE_BYTES     = 40 * 1024 * 1024; // 40MB per file
export const DAILY_UPLOAD_BYTES = 40 * 1024 * 1024; // 40MB per user per day
export const SEND_COOLDOWN_MS   = 1200;             // min ms between sends

// Return the matched automod rule for a piece of text, or null.
// A rule is { id, pattern, action: "block"|"flag" }. `pattern` is tried as a
// case-insensitive regex first, falling back to a plain substring match if the
// pattern isn't valid regex (so non-technical owners can type literal words).
export function matchAutomod(rules, text) {
  if (!text || !Array.isArray(rules)) return null;
  for (const rule of rules) {
    if (!rule || !rule.pattern) continue;
    let hit = false;
    try {
      hit = new RegExp(rule.pattern, "i").test(text);
    } catch {
      hit = text.toLowerCase().includes(rule.pattern.toLowerCase());
    }
    if (hit) return rule;
  }
  return null;
}

// True if this IP is on the global blacklist. Empty/unknown IP is never banned
// (we fail open rather than locking out users whose IP lookup failed).
export function isIpBanned(bannedIps, ip) {
  if (!ip || !Array.isArray(bannedIps)) return false;
  return bannedIps.includes(ip);
}

// True if a send is happening before the cooldown elapsed.
// `now` and `lastSentAt` are epoch millis; pass them in for testability.
export function isRateLimited(now, lastSentAt, cooldownMs = SEND_COOLDOWN_MS) {
  if (typeof lastSentAt !== "number" || lastSentAt <= 0) return false;
  return now - lastSentAt < cooldownMs;
}

// Daily upload accounting. Returns { allowed, remainingBytes, remainingMb }.
// `usedBytes` is today's running total for the user; `fileBytes` the pending file.
export function checkDailyUpload(usedBytes, fileBytes, capBytes = DAILY_UPLOAD_BYTES) {
  const used = Math.max(0, Number(usedBytes) || 0);
  const size = Math.max(0, Number(fileBytes) || 0);
  const remainingBytes = Math.max(0, capBytes - used);
  return {
    allowed: used + size <= capBytes,
    remainingBytes,
    remainingMb: remainingBytes / (1024 * 1024),
  };
}

// True if a single file is within the per-file size cap.
export function isFileSizeOk(fileBytes, capBytes = MAX_FILE_BYTES) {
  return (Number(fileBytes) || 0) <= capBytes;
}

// Validate a team-server join/create choice against whether that server code
// already exists. Refinement step: joining with a typo'd code used to silently
// create a brand-new empty server; creating with a taken code silently hijacked
// it. Pure function — the async Supabase existence lookup stays in TeamChat.
export function validateServerChoice(isCreator, serverExists) {
  if (isCreator && serverExists)
    return { ok: false, error: "That server code already exists — switch to Join, or pick a different code." };
  if (!isCreator && !serverExists)
    return { ok: false, error: "Server not found — double-check the invite code." };
  return { ok: true, error: null };
}

// Human-readable byte size for UI ("3.2 MB", "812 KB").
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
