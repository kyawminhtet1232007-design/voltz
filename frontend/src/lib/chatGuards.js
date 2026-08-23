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

// ── Built-in profanity / slur filter ────────────────────────────────────────
// An always-on blocklist (independent of the owner's custom automod rules) that
// blocks the categories mainstream social platforms disallow: strong profanity,
// explicit sexual terms, and hate slurs. A blocklist must, by nature, contain
// the words it blocks. Kept as data + a pure matcher so it's testable.
//
// Design notes (why it doesn't just substring-match):
//  - Text is normalised first: lowercased, common leet chars mapped to letters
//    (0→o, 1→i, 3→e, 4→a, 5→s, 7→t, 8→b, @→a, $→s), everything non-alphabetic
//    turned into spaces, and 3+ repeated letters collapsed ("fuuuck"→"fuck").
//  - Each term matches with a leading word boundary + optional common suffix +
//    trailing boundary, so "ass" flags "ass"/"asshole"* but NOT "class",
//    "assess", "bass" (avoids the classic "Scunthorpe problem").
//  - A tiny SEVERE set is also matched against the de-spaced string to catch
//    letter-spacing ("n i g g e r"); chosen to have no common innocent substring.
export const DEFAULT_BLOCKLIST = [
  // strong profanity
  "fuck", "motherfucker", "shit", "bullshit", "bitch", "bastard", "asshole",
  "ass", "arse", "arsehole", "dick", "cock", "prick", "piss", "pussy", "cunt",
  "twat", "wanker", "bollocks", "slut", "whore", "douchebag", "jackass",
  // explicit sexual
  "porn", "porno", "blowjob", "handjob", "dildo", "cum", "creampie", "boner",
  "jerkoff", "titties", "nudes",
  // hate slurs (racial / homophobic / ableist)
  "nigger", "nigga", "faggot", "fag", "retard", "retarded", "chink", "kike",
  "spick", "wetback", "tranny", "dyke", "coon", "gook", "beaner", "shemale",
];
// Matched even when letter-spaced / de-spaced. Only terms with no common
// innocent substring collision belong here.
const SEVERE_SQUISHED = ["nigger", "niggers", "faggot", "faggots", "chink", "kike"];

const LEET_MAP = { "0":"o","1":"i","3":"e","4":"a","5":"s","7":"t","8":"b","@":"a","$":"s","|":"i","!":"i" };

// Normalise text for filtering: lowercase, de-leet, non-letters→space,
// collapse 3+ repeats, squeeze spaces.
export function normalizeForFilter(text) {
  let s = String(text || "").toLowerCase();
  s = s.replace(/[0134578@$|!]/g, c => LEET_MAP[c] || c);
  s = s.replace(/[^a-z\s]/g, " ");
  s = s.replace(/([a-z])\1{2,}/g, "$1");
  return s.replace(/\s+/g, " ").trim();
}

// Return the first banned word found in `text`, or null. Pure.
export function containsBannedWord(text, list = DEFAULT_BLOCKLIST) {
  if (!text) return null;
  const norm = normalizeForFilter(text);
  if (!norm) return null;
  for (const w of list) {
    // leading boundary + optional common morphological suffix + trailing boundary
    if (new RegExp(`\\b${w}(?:s|es|ing|ers?|ed|in|z|y)?\\b`).test(norm)) return w;
  }
  const squished = norm.replace(/\s+/g, "");
  for (const w of SEVERE_SQUISHED) {
    if (squished.includes(w)) return w;
  }
  return null;
}

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
