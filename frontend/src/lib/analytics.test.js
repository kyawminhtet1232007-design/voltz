import { describe, it, expect } from "vitest";
import {
  getVisitorId, isNewSession, shouldPromptSignIn,
  getLastPromptAt, markPromptShown,
  SIGNIN_PROMPT_MIN_MS, SIGNIN_PROMPT_MIN_SCROLL, SIGNIN_PROMPT_COOLDOWN_MS,
  _keys,
} from "./analytics.js";

// Minimal in-memory Storage stand-in.
function mkStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

describe("getVisitorId", () => {
  it("creates an id once and reuses it", () => {
    const s = mkStore();
    let n = 0;
    const rng = () => `id-${++n}`;
    const a = getVisitorId(s, rng);
    const b = getVisitorId(s, rng);
    expect(a).toBe("id-1");
    expect(b).toBe("id-1"); // reused, rng not called again
  });

  it("persists under the documented key", () => {
    const s = mkStore();
    getVisitorId(s, () => "abc");
    expect(s.getItem(_keys.VISITOR_KEY)).toBe("abc");
  });

  it("returns a generated id (no throw) when storage is unavailable", () => {
    const id = getVisitorId(null, () => "fallback-1");
    expect(id).toBe("fallback-1");
  });

  it("survives a storage that throws", () => {
    const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => {} };
    expect(getVisitorId(bad, () => "x")).toBe("x");
  });
});

describe("isNewSession", () => {
  it("is true once per session, then false", () => {
    const s = mkStore();
    expect(isNewSession(s)).toBe(true);
    expect(isNewSession(s)).toBe(false);
    expect(isNewSession(s)).toBe(false);
  });
  it("defaults to true when storage missing", () => {
    expect(isNewSession(null)).toBe(true);
  });
});

describe("shouldPromptSignIn", () => {
  const base = { signedIn: false, elapsedMs: SIGNIN_PROMPT_MIN_MS, scrolledPx: SIGNIN_PROMPT_MIN_SCROLL, lastPromptAt: 0, now: 1_000_000 };

  it("fires when engaged, not signed in, and past cooldown", () => {
    expect(shouldPromptSignIn(base)).toBe(true);
  });
  it("never fires for a signed-in user", () => {
    expect(shouldPromptSignIn({ ...base, signedIn: true })).toBe(false);
  });
  it("needs enough time on site", () => {
    expect(shouldPromptSignIn({ ...base, elapsedMs: SIGNIN_PROMPT_MIN_MS - 1 })).toBe(false);
  });
  it("needs enough scroll", () => {
    expect(shouldPromptSignIn({ ...base, scrolledPx: SIGNIN_PROMPT_MIN_SCROLL - 1 })).toBe(false);
  });
  it("respects the cooldown after a recent prompt", () => {
    expect(shouldPromptSignIn({ ...base, lastPromptAt: base.now - 1000 })).toBe(false);
  });
  it("fires again once the cooldown has fully elapsed", () => {
    expect(shouldPromptSignIn({ ...base, lastPromptAt: base.now - SIGNIN_PROMPT_COOLDOWN_MS - 1 })).toBe(true);
  });
});

describe("prompt timestamp persistence", () => {
  it("round-trips the last-prompt time", () => {
    const s = mkStore();
    expect(getLastPromptAt(s)).toBe(0);
    markPromptShown(s, 123456);
    expect(getLastPromptAt(s)).toBe(123456);
  });
  it("reads 0 when storage missing or junk", () => {
    expect(getLastPromptAt(null)).toBe(0);
    const s = mkStore(); s.setItem(_keys.PROMPT_KEY, "not-a-number");
    expect(getLastPromptAt(s)).toBe(0);
  });
});
