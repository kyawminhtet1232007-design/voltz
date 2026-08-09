// ── theme.js ─────────────────────────────────────────────────────────────────
// VexHub design tokens — the single source of truth for the site's color
// system. Chosen over external design tools (e.g. Google Stitch, which
// generates mockups but can't be embedded in a codebase): tokens in code give
// the same professional result AND let us unit-test WCAG contrast.
//
// Families:
//   brand   — the VEX red identity (kept, refined: 600 is the workhorse)
//   slate   — cool neutral ramp for text/borders/surfaces (Tailwind-aligned)
//   dark    — rich navy-black surfaces for the tool pages (CodeLab/CAD);
//             deliberately blue-tinted rather than pure gray for warmth
//   light   — layered light surfaces: tinted page, white cards, soft shadows
//   semantic— status colors (each ≥ AA on white, see theme.test.js)

export const PALETTE = {
  brand: { 50: "#fef2f2", 100: "#fee2e2", 500: "#ef4444", 600: "#dc2626", 700: "#b91c1c" },
  slate: {
    50: "#f8fafc", 100: "#f1f5f9", 200: "#e2e8f0", 300: "#cbd5e1", 400: "#94a3b8",
    500: "#64748b", 600: "#475569", 700: "#334155", 800: "#1e293b", 900: "#0f172a",
  },
  // Apple-style graphite dark (neutral near-black, not navy) — tool pages
  dark: {
    page:       "#000000",                    // app-page background (CodeLab root)
    raised:     "#161617",                    // sidebars / toolbars / panels
    overlay:    "#1d1d1f",                    // popovers, hovers above raised
    border:     "rgba(255,255,255,0.12)",     // visible separator on dark
    borderSoft: "rgba(255,255,255,0.07)",     // hairline separator on dark
  },
  // Apple-style light surfaces: flat #f5f5f7 pages, pure-white tiles
  light: {
    page:    "#f5f5f7",                                                   // Apple light-gray page bg
    card:    "#ffffff",                                                   // raised card / bento tile
    cardAlt: "#f5f5f7",                                                   // inset/alt surface
    border:  "#e2e8f0",                                                   // input/card border
    shadow:  "0 1px 3px rgba(15,23,42,0.06), 0 1px 2px rgba(15,23,42,0.04)", // soft elevation
  },
  semantic: { success: "#047857", warning: "#b45309", error: "#dc2626", info: "#1d4ed8" },
};

// ── Apple design language tokens ─────────────────────────────────────────────
// Typography + ink + link colors matching apple.com. Muted is #6e6e73 (Apple's
// darker gray) rather than their #86868b, because #86868b fails WCAG AA on
// white — we keep the look AND the contrast suite green.
export const APPLE = {
  font: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif',
  ink:        "#1d1d1f",  // primary text (near-black)
  muted:      "#6e6e73",  // secondary text
  blue:       "#0071e3",  // link / CTA blue
  blueHover:  "#0077ed",
  navBg:      "rgba(22,22,23,0.8)", // frosted nav over content
  hairline:   "rgba(255,255,255,0.1)",
};

// Apple pill CTA (filled blue) and text-link styles.
export const APPLE_PILL = {
  background: APPLE.blue, color: "#ffffff", borderRadius: 980, border: "none",
  padding: "12px 24px", fontSize: 15, fontWeight: 500, cursor: "pointer",
};

// Reusable inline-style token for light-surface cards & inputs (replaces the
// old flat `#f9fafb` look with white + crisp border + soft elevation).
export const LIGHT_CARD = {
  background: PALETTE.light.card,
  border: `1px solid ${PALETTE.light.border}`,
  boxShadow: PALETTE.light.shadow,
};

// ── Premium visual language ("Stitch-style" modern SaaS look) ────────────────
// The pieces below are what make pages read as *designed* rather than default:
// a brand gradient, gradient-mesh page backgrounds, glassmorphic elevated cards,
// and gradient display headings.

// Signature brand gradient (red → warm orange). Used on CTAs, active states,
// accent rules, and large display headings.
export const BRAND_GRADIENT = "linear-gradient(135deg, #dc2626 0%, #ea580c 100%)";

// Gradient orange stop — kept saturated enough to pass AA-large (3:1) on white
// so gradient headings remain legible at their lightest point (see theme.test).
export const BRAND_GRADIENT_END = "#ea580c";

// Page backgrounds — Apple style: light pages are DEAD FLAT #f5f5f7 (no mesh);
// dark tool pages get one whisper of neutral top glow over pure black.
export const LIGHT_PAGE_BG = PALETTE.light.page;

export const DARK_PAGE_BG =
  "radial-gradient(1100px 520px at 50% -20%, rgba(255,255,255,0.06), transparent 60%)," +
  PALETTE.dark.page;

// Glassmorphic elevated card for light surfaces (frosted, layered shadow).
export const GLASS_CARD = {
  background: "rgba(255,255,255,0.74)",
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
  border: "1px solid rgba(255,255,255,0.6)",
  boxShadow: "0 12px 34px rgba(15,23,42,0.10), 0 2px 8px rgba(15,23,42,0.05)",
  borderRadius: 20,
};

// Gradient display-heading text. Fallback `color` (solid brand) is set FIRST so
// browsers without background-clip:text still show legible red, not invisible
// text. Apply ONLY to large headings (≥24px bold) — see contrast note above.
export function gradientText(gradient = BRAND_GRADIENT) {
  return {
    color: PALETTE.brand[600],
    backgroundImage: gradient,
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    WebkitTextFillColor: "transparent",
  };
}

// ── WCAG contrast math (used by theme.test.js to prove the palette is AA) ───
export function hexToRgb(hex) {
  const h = String(hex || "").replace("#", "");
  const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(v)) return null;
  return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) };
}

function channelLum(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return 0.2126 * channelLum(rgb.r) + 0.7152 * channelLum(rgb.g) + 0.0722 * channelLum(rgb.b);
}

// WCAG 2.x contrast ratio between two hex colors (1–21). AA normal text ≥ 4.5.
export function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(hexA), lb = relativeLuminance(hexB);
  if (la == null || lb == null) return null;
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
