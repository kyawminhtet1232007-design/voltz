// ── analytics.js ─────────────────────────────────────────────────────────────
// Pure, unit-tested helpers for visitor analytics + the engagement-triggered
// sign-in prompt. No React, no Supabase here — the VexHub layer wires these to
// the DB and UI. Keeping the logic pure means the "when do we nudge sign-in"
// and "who is a unique visitor" rules are testable without a browser or network.
//
// PRIVACY NOTE: analytics identifies a *browser*, not a person — a random
// visitor UUID kept in localStorage. No IP address is stored in analytics; raw
// IP lives only in the separate moderation/ban path (see SECURITY.md).

const VISITOR_KEY   = "voltz_visitor_id";
const SESSION_KEY   = "voltz_session_started";
const PROMPT_KEY    = "voltz_signin_prompt_at"; // last time we showed/dismissed

// Engagement thresholds — a first-time visitor should get to explore before we
// ask anything. The nudge fires once BOTH are true (real reading, not a bounce).
export const SIGNIN_PROMPT_MIN_MS     = 45_000; // ~45s on the site
export const SIGNIN_PROMPT_MIN_SCROLL = 600;    // scrolled at least 600px total
// Don't re-nag: once shown/dismissed, wait this long before it can appear again.
export const SIGNIN_PROMPT_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// A stable per-browser id (random UUID). Powers unique-visitor counts without
// any PII. Created on first call, then reused. Falls back gracefully if
// localStorage or crypto.randomUUID is unavailable (private mode, old browser).
export function getVisitorId(storage, rng) {
  const store = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  const gen = rng || (() =>
    (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : "v-" + Math.abs(hashStr(String((typeof performance !== "undefined" ? performance.now() : 0)))).toString(36) + "-fallback"
  );
  if (!store) return gen();
  try {
    let id = store.getItem(VISITOR_KEY);
    if (!id) { id = gen(); store.setItem(VISITOR_KEY, id); }
    return id;
  } catch { return gen(); }
}

// True the first time it's called in a browser session (used so each session
// records exactly one "visit" row, not one per page navigation). sessionStorage
// is per-tab-session and clears on close — exactly the window we want.
export function isNewSession(storage) {
  const store = storage || (typeof sessionStorage !== "undefined" ? sessionStorage : null);
  if (!store) return true;
  try {
    if (store.getItem(SESSION_KEY)) return false;
    store.setItem(SESSION_KEY, "1");
    return true;
  } catch { return true; }
}

// Pure decision: should the sign-in nudge appear right now? Fires only when the
// visitor is engaged (time AND scroll), isn't already signed in, and we're past
// the cooldown since the last prompt. `now` and `lastPromptAt` are injected so
// the rule is deterministic in tests.
export function shouldPromptSignIn({ signedIn, elapsedMs, scrolledPx, lastPromptAt, now }) {
  if (signedIn) return false;
  if (!(elapsedMs >= SIGNIN_PROMPT_MIN_MS)) return false;
  if (!(scrolledPx >= SIGNIN_PROMPT_MIN_SCROLL)) return false;
  if (lastPromptAt && now - lastPromptAt < SIGNIN_PROMPT_COOLDOWN_MS) return false;
  return true;
}

// Read / write the last-prompt timestamp (dismissal or display). Guarded.
export function getLastPromptAt(storage) {
  const store = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (!store) return 0;
  try { return Number(store.getItem(PROMPT_KEY)) || 0; } catch { return 0; }
}
export function markPromptShown(storage, now) {
  const store = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (!store) return;
  try { store.setItem(PROMPT_KEY, String(now)); } catch { /* ignore */ }
}

// Tiny stable string hash — only used for the visitor-id fallback path.
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
  return h;
}

export const _keys = { VISITOR_KEY, SESSION_KEY, PROMPT_KEY };
