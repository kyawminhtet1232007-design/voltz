// ── sanitizers.js ────────────────────────────────────────────────────────────
// Pure input sanitizers for form fields ("number fields take only numbers,
// word fields take only words"). Applied as the user types, so invalid
// characters never enter component state — no error states needed.
// Pure functions per project convention (CLAUDE.md §10) so they're unit-testable.

// Digits only — for ranking / count fields. Caps length so Number() stays safe.
export function sanitizeDigits(value, maxLen = 6) {
  return String(value ?? "").replace(/\D/g, "").slice(0, maxLen);
}

// Letters, spaces, hyphens, apostrophes — for name/word fields
// ("RoboNinjas", "Pacific Northwest", "O'Brien Bots"). Collapses leading spaces.
export function sanitizeLetters(value, maxLen = 40) {
  return String(value ?? "")
    .replace(/[^A-Za-z\s'-]/g, "")
    .replace(/^\s+/, "")
    .slice(0, maxLen);
}

// VEX team number format: 1–5 digits + one optional trailing letter ("1234A",
// "229V"). Strips anything else and uppercases the letter as the user types.
export function sanitizeTeamNumber(value) {
  const raw = String(value ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  const m = raw.match(/^(\d{0,5})([A-Z]?)/);
  if (!m) return "";
  // The letter suffix is only valid AFTER digits — a leading letter would
  // otherwise get stuck in the field and block all further typing.
  return m[1] ? m[1] + m[2] : "";
}
