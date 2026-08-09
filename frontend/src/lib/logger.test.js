import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLogger, getLogBuffer, clearLogBuffer, LEVELS } from './logger.js';

beforeEach(() => {
  clearLogBuffer();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('createLogger', () => {
  it('records entries to the ring buffer with scope + level', () => {
    const log = createLogger('test-scope');
    log.error('boom', { code: 1 });
    const buf = getLogBuffer();
    expect(buf).toHaveLength(1);
    expect(buf[0]).toMatchObject({ scope: 'test-scope', level: 'error', message: 'boom', data: { code: 1 } });
    expect(buf[0].t).toBeTypeOf('string');
  });

  it('caps the ring buffer (does not grow unbounded)', () => {
    const log = createLogger('flood');
    for (let i = 0; i < 250; i++) log.debug(`m${i}`);
    expect(getLogBuffer().length).toBeLessThanOrEqual(200);
  });

  it('guard() returns the value when fn succeeds', () => {
    const log = createLogger('g');
    expect(log.guard('ok', () => 42)).toBe(42);
    expect(getLogBuffer()).toHaveLength(0); // nothing logged on success
  });

  it('guard() logs and returns the fallback when fn throws', () => {
    const log = createLogger('g');
    const result = log.guard('risky', () => { throw new Error('nope'); }, 'fallback');
    expect(result).toBe('fallback');
    const buf = getLogBuffer();
    expect(buf).toHaveLength(1);
    expect(buf[0].level).toBe('error');
    expect(buf[0].message).toContain('risky failed');
  });

  it('never throws even if console is broken', () => {
    vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('console dead'); });
    const log = createLogger('safe');
    expect(() => log.error('still fine')).not.toThrow();
  });
});

describe('level threshold', () => {
  it('respects a localStorage verbosity override', () => {
    localStorage.setItem('vexhub_log', 'silent');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createLogger('quiet');
    log.error('should be buffered but not printed');
    expect(spy).not.toHaveBeenCalled();           // suppressed from console
    expect(getLogBuffer()).toHaveLength(1);        // still buffered
  });

  it('exposes a sane LEVELS map', () => {
    expect(LEVELS.debug).toBeLessThan(LEVELS.error);
    expect(LEVELS.silent).toBeGreaterThan(LEVELS.error);
  });
});
