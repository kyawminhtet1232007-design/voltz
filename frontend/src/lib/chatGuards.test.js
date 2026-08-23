import { describe, it, expect } from 'vitest';
import {
  matchAutomod, containsBannedWord, normalizeForFilter, isIpBanned, isRateLimited, checkDailyUpload,
  isFileSizeOk, formatBytes, validateServerChoice,
  MAX_FILE_BYTES, DAILY_UPLOAD_BYTES, SEND_COOLDOWN_MS,
} from './chatGuards.js';

describe('containsBannedWord', () => {
  it('blocks plain profanity and slurs', () => {
    expect(containsBannedWord('what the fuck')).toBe('fuck');
    expect(containsBannedWord('you bitch')).toBeTruthy();
    expect(containsBannedWord('total bullshit here')).toBeTruthy();
  });
  it('catches leetspeak and repeated letters', () => {
    expect(containsBannedWord('sh1t')).toBeTruthy();
    expect(containsBannedWord('fuuuuck you')).toBeTruthy();
    expect(containsBannedWord('a$$hole')).toBeTruthy();
  });
  it('catches common morphological suffixes', () => {
    expect(containsBannedWord('stop fucking around')).toBeTruthy();
    expect(containsBannedWord('bitches be like')).toBeTruthy();
  });
  it('catches letter-spaced severe slurs', () => {
    expect(containsBannedWord('n i g g e r')).toBeTruthy();
  });
  it('does NOT flag innocent words (no Scunthorpe problem)', () => {
    expect(containsBannedWord('great class today')).toBeNull();
    expect(containsBannedWord('the assessment was hard')).toBeNull();
    expect(containsBannedWord('sit in the cockpit')).toBeNull();
    expect(containsBannedWord('pass the bass guitar')).toBeNull();
    expect(containsBannedWord('I assume we assemble the robot')).toBeNull();
    expect(containsBannedWord('')).toBeNull();
    expect(containsBannedWord(null)).toBeNull();
  });
});

describe('normalizeForFilter', () => {
  it('lowercases, de-leets, strips punctuation, collapses repeats', () => {
    expect(normalizeForFilter('He110   Wooorld')).toBe('heiio world');
  });
});

describe('matchAutomod', () => {
  const rules = [
    { id: '1', pattern: 'badword', action: 'block' },
    { id: '2', pattern: 'spam\\d+', action: 'flag' }, // regex
  ];

  it('returns null for empty / non-matching text', () => {
    expect(matchAutomod(rules, '')).toBeNull();
    expect(matchAutomod(rules, 'hello world')).toBeNull();
  });

  it('matches a plain substring rule case-insensitively', () => {
    expect(matchAutomod(rules, 'this is a BadWord here')?.id).toBe('1');
  });

  it('matches a regex rule', () => {
    expect(matchAutomod(rules, 'spam42')?.id).toBe('2');
  });

  it('falls back to substring when the pattern is invalid regex', () => {
    const bad = [{ id: 'x', pattern: '(', action: 'block' }];
    expect(matchAutomod(bad, 'a ( b')?.id).toBe('x');
  });

  it('is defensive against bad inputs', () => {
    expect(matchAutomod(null, 'hi')).toBeNull();
    expect(matchAutomod([{ pattern: '' }], 'hi')).toBeNull();
    expect(matchAutomod([null], 'hi')).toBeNull();
  });
});

describe('isIpBanned', () => {
  it('detects a banned ip', () => {
    expect(isIpBanned(['1.2.3.4'], '1.2.3.4')).toBe(true);
  });
  it('fails open for unknown / empty ip', () => {
    expect(isIpBanned(['1.2.3.4'], '')).toBe(false);
    expect(isIpBanned(['1.2.3.4'], null)).toBe(false);
    expect(isIpBanned(null, '1.2.3.4')).toBe(false);
  });
});

describe('isRateLimited', () => {
  it('blocks a send within the cooldown window', () => {
    expect(isRateLimited(1000, 500)).toBe(true);      // 500ms gap < 1200ms
  });
  it('allows a send after the cooldown', () => {
    expect(isRateLimited(3000, 500)).toBe(false);     // 2500ms gap
  });
  it('allows the very first send (no prior timestamp)', () => {
    expect(isRateLimited(1000, 0)).toBe(false);
    expect(isRateLimited(1000, undefined)).toBe(false);
  });
  it('respects a custom cooldown', () => {
    expect(isRateLimited(1000, 400, 500)).toBe(false); // 600ms gap >= 500 -> allowed
    expect(isRateLimited(1000, 700, 500)).toBe(true);  // 300ms gap < 500 -> blocked
  });
});

describe('checkDailyUpload', () => {
  const cap = 40 * 1024 * 1024;
  it('allows an upload under the cap', () => {
    const r = checkDailyUpload(0, 10 * 1024 * 1024);
    expect(r.allowed).toBe(true);
    expect(Math.round(r.remainingMb)).toBe(40);
  });
  it('blocks an upload that would exceed the cap', () => {
    const r = checkDailyUpload(35 * 1024 * 1024, 10 * 1024 * 1024);
    expect(r.allowed).toBe(false);
    expect(Math.round(r.remainingMb)).toBe(5);
  });
  it('allows an upload that exactly hits the cap', () => {
    expect(checkDailyUpload(30 * 1024 * 1024, 10 * 1024 * 1024, cap).allowed).toBe(true);
  });
  it('clamps negative / bad inputs', () => {
    const r = checkDailyUpload(-5, NaN);
    expect(r.allowed).toBe(true);
    expect(r.remainingBytes).toBe(cap);
  });
});

describe('isFileSizeOk', () => {
  it('accepts a file at the limit', () => {
    expect(isFileSizeOk(MAX_FILE_BYTES)).toBe(true);
  });
  it('rejects a file over the limit', () => {
    expect(isFileSizeOk(MAX_FILE_BYTES + 1)).toBe(false);
  });
});

describe('formatBytes', () => {
  it('formats bytes, KB and MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('validateServerChoice', () => {
  it('allows creating a server whose code is unused', () => {
    expect(validateServerChoice(true, false)).toEqual({ ok: true, error: null });
  });
  it('blocks creating a server whose code already exists (hijack prevention)', () => {
    const r = validateServerChoice(true, true);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already exists/i);
  });
  it('allows joining an existing server', () => {
    expect(validateServerChoice(false, true)).toEqual({ ok: true, error: null });
  });
  it('blocks joining a non-existent server (typo no longer creates a ghost server)', () => {
    const r = validateServerChoice(false, false);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });
});

describe('exported constants', () => {
  it('match the documented 40MB / 1.2s policy', () => {
    expect(MAX_FILE_BYTES).toBe(40 * 1024 * 1024);
    expect(DAILY_UPLOAD_BYTES).toBe(40 * 1024 * 1024);
    expect(SEND_COOLDOWN_MS).toBe(1200);
  });
});
