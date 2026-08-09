import { describe, it, expect } from 'vitest';
import { sanitizeDigits, sanitizeLetters, sanitizeTeamNumber } from './sanitizers.js';

describe('sanitizeDigits (ranking fields)', () => {
  it('keeps digits and strips everything else', () => {
    expect(sanitizeDigits('480')).toBe('480');
    expect(sanitizeDigits('4a8!0 ')).toBe('480');
    expect(sanitizeDigits('abc')).toBe('');
  });
  it('rejects signs, decimals and exponent notation', () => {
    expect(sanitizeDigits('-12')).toBe('12');
    expect(sanitizeDigits('1.5')).toBe('15');
    expect(sanitizeDigits('1e9')).toBe('19');
  });
  it('caps length so Number() stays in safe range', () => {
    expect(sanitizeDigits('123456789')).toBe('123456');
  });
  it('tolerates null/undefined', () => {
    expect(sanitizeDigits(null)).toBe('');
    expect(sanitizeDigits(undefined)).toBe('');
  });
});

describe('sanitizeLetters (word fields)', () => {
  it('keeps letters, spaces, hyphens, apostrophes', () => {
    expect(sanitizeLetters('RoboNinjas')).toBe('RoboNinjas');
    expect(sanitizeLetters('Pacific Northwest')).toBe('Pacific Northwest');
    expect(sanitizeLetters("O'Brien-Bots")).toBe("O'Brien-Bots");
  });
  it('strips digits and symbols as typed', () => {
    expect(sanitizeLetters('Robo123Ninjas!')).toBe('RoboNinjas');
    expect(sanitizeLetters('Team #42 <script>')).toBe('Team  script');
  });
  it('trims leading whitespace and caps length', () => {
    expect(sanitizeLetters('   Hello')).toBe('Hello');
    expect(sanitizeLetters('a'.repeat(60))).toHaveLength(40);
  });
});

describe('sanitizeTeamNumber (VEX format: digits + optional letter)', () => {
  it('accepts the canonical formats', () => {
    expect(sanitizeTeamNumber('1234A')).toBe('1234A');
    expect(sanitizeTeamNumber('229V')).toBe('229V');
    expect(sanitizeTeamNumber('39')).toBe('39');
  });
  it('uppercases the letter as typed', () => {
    expect(sanitizeTeamNumber('1234a')).toBe('1234A');
  });
  it('drops anything after the letter and non-alphanumerics', () => {
    expect(sanitizeTeamNumber('1234AB')).toBe('1234A');
    expect(sanitizeTeamNumber('12-34A!')).toBe('1234A');
  });
  it('caps digits at 5 (longest sanctioned team numbers)', () => {
    expect(sanitizeTeamNumber('1234567')).toBe('12345');
  });
  it('a leading letter cannot start a team number (dropped, not stuck)', () => {
    expect(sanitizeTeamNumber('A')).toBe('');
    expect(sanitizeTeamNumber('A1234')).toBe('');
  });
  it('tolerates empty/null input', () => {
    expect(sanitizeTeamNumber('')).toBe('');
    expect(sanitizeTeamNumber(null)).toBe('');
  });
});
