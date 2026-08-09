// ── logger.js ──────────────────────────────────────────────────────────────
// Lightweight structured logger for VexHub.
//
// Why this exists: the codebase previously swallowed errors in empty `catch {}`
// blocks and had zero console output, making production issues undiagnosable.
// This gives every subsystem a scoped logger with levels, an in-memory ring
// buffer (for an in-app debug panel / bug-report export), and dev/prod gating.
//
// Design goals:
//   - NEVER throw. A logger that crashes the app is worse than no logger.
//   - Cheap in production: debug/info are suppressed unless explicitly enabled.
//   - Structured: each entry carries a timestamp, level, scope, message, data.
//   - Testable: pure buffer logic, no hard dependency on import.meta.

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

// Resolve the active threshold. In dev we show everything from debug up;
// in prod we only surface warn/error. A localStorage override ("vexhub_log")
// lets us crank up verbosity in a deployed build without a rebuild.
function resolveThreshold() {
  try {
    const override = typeof localStorage !== "undefined" && localStorage.getItem("vexhub_log");
    if (override && LEVELS[override] != null) return LEVELS[override];
  } catch { /* localStorage may be unavailable (SSR / privacy mode) */ }
  // import.meta.env.DEV is true under `vite dev` and in vitest.
  const isDev = typeof import.meta !== "undefined" && import.meta.env && import.meta.env.DEV;
  return isDev ? LEVELS.debug : LEVELS.warn;
}

const RING_MAX = 200;
const ring = [];

// Exposed for tests and for an in-app "export logs" / debug panel.
export function getLogBuffer() { return ring.slice(); }
export function clearLogBuffer() { ring.length = 0; }

function record(level, scope, message, data) {
  const entry = {
    t: new Date().toISOString(),
    level,
    scope,
    message: String(message),
    // Keep data serializable-ish; store the raw value but guard stringify at read time.
    data: data === undefined ? null : data,
  };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();
  return entry;
}

function emit(level, scope, message, data) {
  try {
    const entry = record(level, scope, message, data);
    if (LEVELS[level] < resolveThreshold()) return entry; // below threshold: buffered but not printed
    const tag = `[${scope}]`;
    const fn = level === "error" ? console.error
             : level === "warn" ? console.warn
             : level === "info" ? console.info
             : console.debug;
    if (data !== undefined) fn(tag, message, data);
    else fn(tag, message);
    return entry;
  } catch {
    // A failure inside logging must never propagate.
    return null;
  }
}

// Create a logger bound to a subsystem name, e.g. createLogger("chat").
export function createLogger(scope = "app") {
  return {
    debug: (msg, data) => emit("debug", scope, msg, data),
    info:  (msg, data) => emit("info",  scope, msg, data),
    warn:  (msg, data) => emit("warn",  scope, msg, data),
    error: (msg, data) => emit("error", scope, msg, data),
    // Wrap a throwing fn so a failure is logged (not swallowed) and a fallback returned.
    // Replaces the old `try { ... } catch {}` pattern with something diagnosable.
    guard: (label, fn, fallback = undefined) => {
      try { return fn(); }
      catch (e) { emit("error", scope, `${label} failed`, e?.message || e); return fallback; }
    },
  };
}

// Default app-scoped logger for one-off use.
export const log = createLogger("app");
