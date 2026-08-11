// ── scrollFx.jsx ─────────────────────────────────────────────────────────────
// GSAP motion system for VexHub — the site-wide UI/UX animation layer.
//
// Pieces (all reduced-motion-aware, all fail-safe — content is never stranded
// hidden if an animation can't run):
//
//   SCROLL REVEALS — mark any element with `data-reveal`:
//     data-reveal="up"      → rise + fade in (default)
//     data-reveal="left"    → slide in from the left
//     data-reveal="right"   → slide in from the right
//     data-reveal="scale"   → grow + rise in
//     data-reveal="fade"    → fade only
//     data-reveal="stagger" → the element's CHILDREN cascade one after another
//     data-reveal-delay="0.2" → optional extra delay (seconds)
//
//   PARALLAX — `data-parallax="12"`: element drifts up 12% of its height while
//     it crosses the viewport (scrubbed to scroll, transform-only → no layout).
//
//   <ScrollFx pageKey/>     → mounted once; re-scans both attribute systems on
//                             every SPA page switch (gsap.context cleanup).
//   <ScrollProgress/>       → 3px scroll progress bar pinned to the top edge.
//   animatePageEnter(el)    → GSAP page transition (used by PageTransition).
//   animateSwap(container)  → cascade a container's children in (tab switches).
//   useSwapAnimation(dep)   → ref + effect wrapper around animateSwap.
//   popIn(el)               → springy entrance for floating UI (Rio button).
//
// Hard-won rules encoded here (see git/test history):
//   - NEVER pre-hide an element while waiting for a trigger (fast page switches
//     stranded content invisible). In-view elements animate immediately;
//     below-fold ones hide+reveal atomically inside onEnter.
//   - Suspend CSS `transition` classes for a tween's lifetime (they fight
//     GSAP's per-frame updates → jank); clearProps restores them on complete.

import React, { useEffect, useLayoutEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { createLogger } from "./logger.js";

gsap.registerPlugin(ScrollTrigger);

const fxLog = createLogger("scrollfx");

// Pure: map a data-reveal variant + delay to gsap.from() vars (unit-tested).
export function revealVars(variant = "up", delay = 0) {
  const base = { opacity: 0, duration: 0.7, ease: "power3.out", delay: Number(delay) || 0 };
  switch (variant) {
    case "left":    return { ...base, x: -40 };
    case "right":   return { ...base, x: 40 };
    case "scale":   return { ...base, scale: 0.92, y: 24 };
    case "fade":    return base;
    case "stagger": return { ...base, y: 28, stagger: 0.1 };
    case "up":
    default:        return { ...base, y: 32 };
  }
}

// True when the OS asks for reduced motion. Guarded — jsdom has no matchMedia.
export function prefersReducedMotion() {
  try {
    return typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch { return false; }
}

// Internal: suspend CSS transition classes, then play a from-tween that cleans up
// ONLY what it touched (the animated opacity/transform + the suspension) when it
// completes. Must NOT use clearProps:"all" — that also wipes author inline styles
// like background/border/boxShadow, which made revealed cards lose their box.
function fromSafe(target, vars) {
  gsap.set(target, { transition: "none" });
  // `gsap.from` applies the hidden start-state immediately (immediateRender). If
  // the tween is then KILLED before it finishes — React StrictMode double-invoking
  // the effect in dev, a fast re-navigation, a context revert mid-flight — the
  // element can be stranded at opacity:0. onInterrupt clears the props so an
  // interrupted reveal always falls back to its natural (visible) state.
  return gsap.from(target, {
    ...vars,
    clearProps: "opacity,transform,transition",
    onInterrupt: () => gsap.set(target, { clearProps: "opacity,transform,transition" }),
  });
}

// Scan `root` for [data-reveal] + [data-parallax] elements and attach their
// animations. Returns a cleanup that reverts all inline styles + kills triggers.
export function initScrollFx(root = document) {
  if (prefersReducedMotion()) {
    fxLog.info("prefers-reduced-motion set — scroll animations disabled");
    return () => {};
  }
  // Subtrees marked data-fx-scope run their OWN initScrollFx (Lessons overview,
  // lesson detail, Resources hub/reader). The app-level document scan must skip
  // them — double-scanning restarts their tweens a frame later (visible stutter).
  const unscoped  = (els) => (root === document ? els.filter((el) => !el.closest("[data-fx-scope]")) : els);
  const reveals   = unscoped(Array.from(root.querySelectorAll("[data-reveal]")));
  const parallaxe = unscoped(Array.from(root.querySelectorAll("[data-parallax]")));
  const counters  = unscoped(Array.from(root.querySelectorAll("[data-count-to]")));
  if (!reveals.length && !parallaxe.length && !counters.length) return () => {};

  const vh = (typeof window !== "undefined" && window.innerHeight) || 800;
  let immediate = 0, deferred = 0;
  const immediateEls = []; // in-view reveals, swept below if a tween is stranded

  const ctx = gsap.context(() => {
    // Page-switch entrance: the in-view blocks cascade in one after another so a
    // tab click reads as a smooth ~1s reveal, not an instant snap. `order` is the
    // element's position among the in-view set, used to stagger its start.
    const animate = (el, order = null) => {
      const variant = el.dataset.reveal || "up";
      // "stagger" animates the element's CHILDREN as a cascade.
      const target = variant === "stagger" ? Array.from(el.children) : el;
      if (variant === "stagger" && !el.children.length) return;
      const vars = revealVars(variant, el.dataset.revealDelay);
      if (order != null) {
        // Deliberate, smooth entrance — softly eased, gently cascaded, capped so
        // the whole page still finishes revealing within ~1s. Pre-paint hides
        // these before first paint (layout effect) so there's no flash.
        vars.duration = 0.7;
        vars.ease = "power3.out";
        vars.delay = Math.min((vars.delay || 0) + order * 0.08, 0.6);
      }
      fromSafe(target, vars);
    };

    let inView = 0;
    reveals.forEach((el) => {
      // Same threshold as the trigger's start ("top 88%"): in-view elements
      // cascade in now, everything else waits for scroll.
      if (el.getBoundingClientRect().top < vh * 0.88) {
        immediate++;
        immediateEls.push(el);
        animate(el, inView++); // cascade in, ordered by position
        return;
      }
      deferred++;
      ScrollTrigger.create({ trigger: el, start: "top 88%", once: true, onEnter: () => animate(el) }); // full reveal on scroll
    });

    // Parallax: drift the element up N% of its own height while it crosses the
    // viewport, scrubbed to the scrollbar. Transform-only — zero layout cost.
    parallaxe.forEach((el) => {
      const strength = Math.abs(parseFloat(el.dataset.parallax)) || 12;
      gsap.to(el, {
        yPercent: -strength,
        ease: "none",
        scrollTrigger: { trigger: el, start: "top bottom", end: "bottom top", scrub: 0.4 },
      });
    });

    // Counters: `data-count-to="30"` (+ optional data-count-suffix="+") ticks the
    // element's text from 0 to N when it scrolls into view. Fail-safe: the JSX
    // already contains the final value as static text, so if the trigger never
    // fires the real number is simply shown un-animated.
    counters.forEach((el) => {
      const to = parseFloat(el.dataset.countTo);
      if (!Number.isFinite(to)) return;
      const suffix = el.dataset.countSuffix || "";
      const proxy = { val: 0 };
      const run = () => gsap.to(proxy, {
        val: to, duration: 1.4, ease: "power2.out",
        onUpdate: () => { el.textContent = Math.round(proxy.val) + suffix; },
      });
      if (el.getBoundingClientRect().top < vh * 0.88) { run(); return; }
      ScrollTrigger.create({ trigger: el, start: "top 88%", once: true, onEnter: run });
    });
  });

  // Safety sweep OUTSIDE the gsap context (a plain timer, so context.revert()
  // can't kill it): after the cascade should be done, force visible any in-view
  // element still stranded at opacity:0 by a killed from-tween (StrictMode double
  // invoke, fast re-navigation). Cleared on cleanup so it never fires post-unmount.
  let sweepId = 0;
  if (immediateEls.length) {
    sweepId = setTimeout(() => {
      immediateEls.forEach((el) => {
        const nodes = el.dataset.reveal === "stagger" ? Array.from(el.children) : [el];
        nodes.forEach((n) => {
          if (n && getComputedStyle(n).opacity === "0") gsap.set(n, { clearProps: "opacity,transform,transition" });
        });
      });
    }, 1500);
  }

  fxLog.debug("scroll fx attached", { immediate, deferred, parallax: parallaxe.length });
  return () => { clearTimeout(sweepId); ctx.revert(); };
}

// Gentle infinite idle bob for a floating element (e.g. the chat launcher) so it
// feels alive. Returns a cleanup that stops the loop and resets the transform.
// Reduced-motion safe (no-op). Only touches y — pair it with drag/hover transforms
// on a DIFFERENT element to avoid clobbering.
export function floatIdle(el, { distance = 6, duration = 1.8 } = {}) {
  if (!el || prefersReducedMotion()) return () => {};
  const tween = gsap.to(el, { y: -distance, duration, ease: "sine.inOut", repeat: -1, yoyo: true });
  return () => { tween.kill(); gsap.set(el, { y: 0 }); };
}

// Recompute every ScrollTrigger's start/end. Call after late layout shifts (images
// finishing load, fonts) so deferred reveals fire as the element enters from the
// bottom instead of blinking out mid-screen. Never re-hides already-shown content.
export function refreshScrollFx() {
  try { ScrollTrigger.refresh(); } catch { /* no-op outside the browser */ }
}

// Mount ONCE in the app shell. Re-scans the DOM each time the page changes.
// useLayoutEffect (not useEffect/rAF): it runs at commit, BEFORE the browser
// paints the new page. Scroll to top first so in-view measurements are taken
// from the top of the incoming page, then hide+animate reveals pre-paint —
// the old rAF version let the page paint fully visible for one frame, then
// snapped it hidden to fade it back in (the "flash then ghost" jank).
export function ScrollFx({ pageKey }) {
  useLayoutEffect(() => {
    try { window.scrollTo(0, 0); } catch { /* jsdom */ }
    return initScrollFx(document);
  }, [pageKey]);
  return null;
}

// GSAP page transition — fade + rise the incoming page. fromTo (not from) so
// repeat navigations always start from the same state; clearProps leaves the
// page style-free afterwards. Fail-safe: the element is never pre-hidden.
export function animatePageEnter(el) {
  if (!el || prefersReducedMotion()) return null;
  // A soft, deliberate page rise+fade that reads as a smooth transition. The
  // per-element reveals cascade in on top of it (see initScrollFx); together
  // they give a ~1s smooth entrance. Pre-paint (layout effect) means no flash.
  return gsap.fromTo(el,
    { opacity: 0, y: 18 },
    { opacity: 1, y: 0, duration: 0.55, ease: "power3.out", clearProps: "all" });
}

// Cascade a container's children in — used when tab panels swap content.
export function animateSwap(container) {
  if (!container || prefersReducedMotion()) return null;
  const kids = Array.from(container.children);
  if (!kids.length) return null;
  return fromSafe(kids, { opacity: 0, y: 14, duration: 0.35, ease: "power2.out", stagger: 0.05 });
}

// Ref + effect wrapper: const ref = useSwapAnimation(activeTab); attach ref to
// the tab-content wrapper and each tab change cascades the new panel in.
// Skips the initial mount (page-level entrances already cover it).
export function useSwapAnimation(dep) {
  const ref = useRef(null);
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    animateSwap(ref.current);
  }, [dep]);
  return ref;
}

// Scroll-spy: returns the id of the section currently crossing the middle of
// the viewport. Drives "which chapter am I in" highlighting for sticky chapter
// navs (Resources). Reduced-motion safe — it's state tracking, not motion, so
// it always runs. Pass a stable array of element ids.
export function useScrollSpy(ids) {
  const [activeId, setActiveId] = React.useState(ids?.[0] ?? null);
  const activeSet = useRef(new Set());
  useEffect(() => {
    const triggers = [];
    activeSet.current.clear();
    // Wait a frame so the sections exist in the DOM after a page/tab mount.
    const raf = requestAnimationFrame(() => {
      (ids || []).forEach((id) => {
        const el = document.getElementById(id);
        if (!el) { fxLog.warn("useScrollSpy: missing section", { id }); return; }
        triggers.push(ScrollTrigger.create({
          trigger: el,
          start: "top center",
          end: "bottom center",
          // Track ALL toggles (on and off). When nothing crosses the viewport
          // center (e.g. scrolled to the very top), fall back to the first
          // section instead of holding whichever id happened to fire last
          // during mount-time measurement.
          onToggle: (self) => {
            if (self.isActive) activeSet.current.add(id);
            else activeSet.current.delete(id);
            const current = [...activeSet.current];
            setActiveId(current.length ? current[current.length - 1] : (ids?.[0] ?? null));
          },
        }));
      });
    });
    return () => { cancelAnimationFrame(raf); triggers.forEach((t) => t.kill()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(ids)]);
  return activeId;
}

// Springy entrance for floating UI elements (e.g. the Rio assistant button).
export function popIn(el) {
  if (!el || prefersReducedMotion()) return null;
  return fromSafe(el, { scale: 0, opacity: 0, duration: 0.5, ease: "back.out(1.7)" });
}

// 3px scroll-progress bar pinned above everything, scrubbed to page scroll.
// Decorative only (aria-hidden); transform-only so it never causes layout.
export function ScrollProgress() {
  const barRef = useRef(null);
  useEffect(() => {
    if (!barRef.current || prefersReducedMotion()) return;
    const tween = gsap.to(barRef.current, {
      scaleX: 1,
      ease: "none",
      scrollTrigger: { start: 0, end: "max", scrub: 0.3 },
    });
    return () => { tween.scrollTrigger?.kill(); tween.kill(); };
  }, []);
  return (
    <div ref={barRef} aria-hidden="true"
      style={{ position: "fixed", top: 0, left: 0, right: 0, height: 3, transform: "scaleX(0)", transformOrigin: "0 0", background: "linear-gradient(90deg,#dc2626,#f87171)", zIndex: 10002, pointerEvents: "none" }} />
  );
}
