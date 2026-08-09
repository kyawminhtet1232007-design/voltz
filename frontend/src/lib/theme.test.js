import { describe, it, expect } from 'vitest';
import {
  PALETTE, LIGHT_CARD, hexToRgb, relativeLuminance, contrastRatio,
  BRAND_GRADIENT, BRAND_GRADIENT_END, GLASS_CARD, gradientText, LIGHT_PAGE_BG, DARK_PAGE_BG,
  APPLE, APPLE_PILL,
} from './theme.js';

describe('contrast math (WCAG 2.x)', () => {
  it('computes the canonical extremes', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 1);
  });
  it('is symmetric and tolerant of 3-digit hex', () => {
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(contrastRatio('#000', '#fff'), 5);
  });
  it('returns null for junk input', () => {
    expect(hexToRgb('nope')).toBeNull();
    expect(relativeLuminance('xyz')).toBeNull();
    expect(contrastRatio('#fff', 'banana')).toBeNull();
  });
});

// These assertions pin the REAL pairings used across the site. If someone
// "tweaks" a token below AA, the suite fails — accessibility as a unit test.
describe('palette meets WCAG AA where it is actually used', () => {
  const AA = 4.5;
  it('primary text on every light surface', () => {
    expect(contrastRatio(PALETTE.slate[900], PALETTE.light.card)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(PALETTE.slate[900], PALETTE.light.page)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(PALETTE.slate[900], PALETTE.light.cardAlt)).toBeGreaterThanOrEqual(AA);
  });
  it('muted text on light surfaces', () => {
    expect(contrastRatio(PALETTE.slate[500], PALETTE.light.card)).toBeGreaterThanOrEqual(AA);
  });
  it('white text on the brand red (buttons)', () => {
    expect(contrastRatio('#ffffff', PALETTE.brand[600])).toBeGreaterThanOrEqual(AA);
  });
  it('light text on the dark tool surfaces', () => {
    expect(contrastRatio(PALETTE.slate[100], PALETTE.dark.page)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(PALETTE.slate[100], PALETTE.dark.raised)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(PALETTE.slate[400], PALETTE.dark.raised)).toBeGreaterThanOrEqual(AA);
  });
  it('every semantic status color on white', () => {
    for (const c of Object.values(PALETTE.semantic)) {
      expect(contrastRatio(c, '#ffffff')).toBeGreaterThanOrEqual(AA);
    }
  });
});

describe('LIGHT_CARD token', () => {
  it('composes the palette values (no drift between token and palette)', () => {
    expect(LIGHT_CARD.background).toBe(PALETTE.light.card);
    expect(LIGHT_CARD.border).toContain(PALETTE.light.border);
    expect(LIGHT_CARD.boxShadow).toBe(PALETTE.light.shadow);
  });
});

describe('premium visual tokens', () => {
  it('gradient display-heading stops both pass AA-large (3:1) on the light page', () => {
    // Gradient headings span brand-600 → brand orange; both ends must stay
    // legible at large-text size against the lightest page surface.
    expect(contrastRatio(PALETTE.brand[600], PALETTE.light.page)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(BRAND_GRADIENT_END, PALETTE.light.page)).toBeGreaterThanOrEqual(3);
  });
  it('gradientText() keeps a solid brand fallback so text is never invisible', () => {
    const s = gradientText();
    expect(s.color).toBe(PALETTE.brand[600]);          // fallback first
    expect(s.WebkitTextFillColor).toBe('transparent'); // gradient on top
    expect(s.backgroundImage).toBe(BRAND_GRADIENT);
  });
  it('Apple-style page backgrounds: light is dead flat, dark gets one neutral glow', () => {
    expect(LIGHT_PAGE_BG).toBe(PALETTE.light.page);          // flat #f5f5f7, no mesh
    expect(DARK_PAGE_BG).toContain(PALETTE.dark.page);
    expect(DARK_PAGE_BG).toContain('radial-gradient');
  });
  it('GLASS_CARD is frosted with a layered shadow', () => {
    expect(GLASS_CARD.backdropFilter).toContain('blur');
    expect(GLASS_CARD.boxShadow).toContain('rgba');
  });
});

describe('Apple design tokens', () => {
  const AA = 4.5;
  it('ink and muted text pass AA on both Apple light surfaces', () => {
    expect(contrastRatio(APPLE.ink, PALETTE.light.page)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(APPLE.ink, PALETTE.light.card)).toBeGreaterThanOrEqual(AA);
    // #6e6e73 chosen over apple.com's #86868b precisely to clear this bar
    expect(contrastRatio(APPLE.muted, PALETTE.light.page)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(APPLE.muted, PALETTE.light.card)).toBeGreaterThanOrEqual(AA);
  });
  it('white text on the Apple blue pill passes AA', () => {
    expect(contrastRatio('#ffffff', APPLE.blue)).toBeGreaterThanOrEqual(AA);
    expect(APPLE_PILL.background).toBe(APPLE.blue);
    expect(APPLE_PILL.borderRadius).toBeGreaterThan(100); // pill, not rounded-rect
  });
  it('graphite dark family keeps light text AA', () => {
    expect(contrastRatio(PALETTE.slate[100], PALETTE.dark.raised)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(PALETTE.slate[400], PALETTE.dark.raised)).toBeGreaterThanOrEqual(AA);
  });
  it('system font stack leads with -apple-system', () => {
    expect(APPLE.font.startsWith('-apple-system')).toBe(true);
  });
});
