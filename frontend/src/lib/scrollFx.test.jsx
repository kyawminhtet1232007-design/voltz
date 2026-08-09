import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import {
  revealVars, prefersReducedMotion, initScrollFx,
  animatePageEnter, animateSwap, popIn, ScrollProgress, useScrollSpy,
} from './scrollFx.jsx';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

afterEach(() => {
  ScrollTrigger.getAll().forEach(st => st.kill());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('revealVars (variant → gsap vars mapping)', () => {
  it('defaults to the "up" variant (rise + fade)', () => {
    const v = revealVars();
    expect(v.opacity).toBe(0);
    expect(v.y).toBe(32);
  });
  it('maps each named variant to its motion', () => {
    expect(revealVars('left').x).toBe(-40);
    expect(revealVars('right').x).toBe(40);
    expect(revealVars('scale').scale).toBeCloseTo(0.92);
    expect(revealVars('fade').y).toBeUndefined();
    expect(revealVars('stagger').stagger).toBeCloseTo(0.1);
  });
  it('parses the delay and tolerates junk', () => {
    expect(revealVars('up', '0.3').delay).toBeCloseTo(0.3);
    expect(revealVars('up', 'banana').delay).toBe(0);
    expect(revealVars('up', undefined).delay).toBe(0);
  });
  it('falls back to "up" for unknown variants', () => {
    expect(revealVars('spin-wildly').y).toBe(32);
  });
});

describe('prefersReducedMotion', () => {
  it('is false when matchMedia is unavailable (fail-open to animations)', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
  it('reflects the media query result', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    expect(prefersReducedMotion()).toBe(true);
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
    expect(prefersReducedMotion()).toBe(false);
  });
});

// jsdom has no layout: every element reports top 0, so a `once:true` trigger
// fires-and-kills itself at creation. Pretend the element is far below the
// viewport so triggers persist and can be counted (matches real-browser life).
function placeOffscreen(el) {
  el.getBoundingClientRect = () => ({ top: 5000, bottom: 5100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 5000 });
}

describe('initScrollFx', () => {
  it('creates one ScrollTrigger per data-reveal element and cleans them all up', () => {
    document.body.innerHTML = `
      <section>
        <h1 data-reveal="up">title</h1>
        <p data-reveal="left">copy</p>
        <div data-reveal="stagger"><span>a</span><span>b</span></div>
      </section>`;
    document.querySelectorAll('[data-reveal]').forEach(placeOffscreen);
    const cleanup = initScrollFx(document);
    expect(ScrollTrigger.getAll().length).toBe(3);
    cleanup();
    expect(ScrollTrigger.getAll().length).toBe(0);
  });

  it('skips an empty stagger container instead of crashing', () => {
    document.body.innerHTML = `<div data-reveal="stagger"></div>`;
    const cleanup = initScrollFx(document);
    expect(ScrollTrigger.getAll().length).toBe(0);
    cleanup();
  });

  it('creates nothing when prefers-reduced-motion is set (WCAG 2.3.3)', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    document.body.innerHTML = `<h1 data-reveal="up">title</h1>`;
    // off-screen so the normal path WOULD create a persistent trigger —
    // makes the 0 assertion below actually discriminate.
    document.querySelectorAll('[data-reveal]').forEach(placeOffscreen);
    const cleanup = initScrollFx(document);
    expect(ScrollTrigger.getAll().length).toBe(0);
    expect(cleanup).toBeTypeOf('function');
    cleanup(); // noop, must not throw
  });

  it('returns a noop cleanup when no elements are marked', () => {
    document.body.innerHTML = `<p>nothing marked</p>`;
    const cleanup = initScrollFx(document);
    expect(ScrollTrigger.getAll().length).toBe(0);
    expect(() => cleanup()).not.toThrow();
  });

  it('elements already in view animate immediately with NO trigger (fail-safe: never pre-hidden)', async () => {
    const gsap = (await import('gsap')).default;
    document.body.innerHTML = `<h1 data-reveal="up">in view</h1>`; // jsdom rect top=0 → in view
    const el = document.querySelector('h1');
    const cleanup = initScrollFx(document);
    expect(ScrollTrigger.getAll().length).toBe(0);     // no deferred trigger
    expect(gsap.getTweensOf(el).length).toBeGreaterThan(0); // entrance tween playing now
    cleanup();
  });

  it('cleanup reverts inline styles so elements are left untouched', () => {
    document.body.innerHTML = `<h1 data-reveal="up">title</h1>`;
    const el = document.querySelector('h1');
    const cleanup = initScrollFx(document);
    cleanup();
    expect(el.getAttribute('style') || '').toBe('');
  });

  it('suspends CSS transitions while animating (they fight GSAP ticks → jank)', () => {
    // Cards have Tailwind `transition` hover classes; GSAP must override them
    // with `transition: none` for the tween's lifetime.
    document.body.innerHTML = `<div data-reveal="stagger"><div class="transition">card</div></div>`;
    const card = document.querySelector('.transition');
    const cleanup = initScrollFx(document); // in view → animates immediately
    expect(card.style.transition).toBe('none');
    cleanup(); // revert removes the override so hover transitions return
    expect(card.getAttribute('style') || '').toBe('');
  });

  it('a completed reveal keeps author inline styles (bg/border) — only clears its own opacity/transform/transition', async () => {
    // Regression: clearProps:"all" used to wipe the card's inline background/border
    // when the entrance finished, so revealed cards lost their box. The tween must
    // only clean up what IT set.
    const gsap = (await import('gsap')).default;
    document.body.innerHTML =
      `<div data-reveal="stagger"><div class="card" style="background: rgb(255, 255, 255); border-color: rgb(236, 236, 239); border-width: 1px;">card</div></div>`;
    const card = document.querySelector('.card');
    const cleanup = initScrollFx(document); // in view → animates immediately
    gsap.getTweensOf(card).forEach((t) => t.progress(1)); // fast-forward → fires clearProps
    expect(card.style.background).toContain('255');          // author bg survives
    expect(card.style.borderColor).toContain('236');         // author border survives
    expect(card.style.opacity).toBe('');                     // GSAP's own props cleared
    expect(card.style.transition).toBe('');                  // suspension cleared
    cleanup();
  });

  it('attaches a persistent scrub trigger for data-parallax elements', () => {
    document.body.innerHTML = `<section data-parallax="14">hero</section>`;
    const cleanup = initScrollFx(document);
    expect(ScrollTrigger.getAll().length).toBe(1); // scrub trigger, not once
    cleanup();
    expect(ScrollTrigger.getAll().length).toBe(0);
  });

  it('falls back to the default parallax strength for junk values', () => {
    document.body.innerHTML = `<section data-parallax="banana">hero</section>`;
    const cleanup = initScrollFx(document);
    expect(ScrollTrigger.getAll().length).toBe(1); // still created, default strength
    cleanup();
  });
});

describe('animatePageEnter (GSAP page transition)', () => {
  it('returns a tween that animates the page element', () => {
    document.body.innerHTML = `<main>page</main>`;
    const el = document.querySelector('main');
    const tween = animatePageEnter(el);
    expect(tween).toBeTruthy();
    expect(gsap.getTweensOf(el).length).toBeGreaterThan(0);
    tween.kill();
  });
  it('is a no-op for null elements and under reduced motion (fail-safe)', () => {
    expect(animatePageEnter(null)).toBeNull();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    document.body.innerHTML = `<main>page</main>`;
    expect(animatePageEnter(document.querySelector('main'))).toBeNull();
  });
});

describe('animateSwap (tab panel cascade)', () => {
  it('animates the container children with suspended CSS transitions', () => {
    document.body.innerHTML = `<div id="panel"><div class="transition">a</div><div>b</div></div>`;
    const panel = document.getElementById('panel');
    const tween = animateSwap(panel);
    expect(tween).toBeTruthy();
    expect(panel.children[0].style.transition).toBe('none');
    tween.kill();
  });
  it('is a no-op for empty containers, null, and reduced motion', () => {
    document.body.innerHTML = `<div id="empty"></div>`;
    expect(animateSwap(document.getElementById('empty'))).toBeNull();
    expect(animateSwap(null)).toBeNull();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    document.body.innerHTML = `<div id="p"><span>x</span></div>`;
    expect(animateSwap(document.getElementById('p'))).toBeNull();
  });
});

describe('popIn (floating UI entrance)', () => {
  it('returns a springy tween and suspends CSS transitions', () => {
    document.body.innerHTML = `<button class="transition">Rio</button>`;
    const el = document.querySelector('button');
    const tween = popIn(el);
    expect(tween).toBeTruthy();
    expect(el.style.transition).toBe('none');
    tween.kill();
  });
  it('is a no-op under reduced motion', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    document.body.innerHTML = `<button>Rio</button>`;
    expect(popIn(document.querySelector('button'))).toBeNull();
  });
});

describe('ScrollProgress', () => {
  it('renders a decorative bar and scrubs it via a ScrollTrigger; unmount cleans up', () => {
    const { container, unmount } = render(<ScrollProgress />);
    const bar = container.firstChild;
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    expect(ScrollTrigger.getAll().length).toBe(1);
    unmount();
    expect(ScrollTrigger.getAll().length).toBe(0);
  });
  it('creates no trigger under reduced motion', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    const { unmount } = render(<ScrollProgress />);
    expect(ScrollTrigger.getAll().length).toBe(0);
    unmount();
  });
});

describe('data-count-to counters', () => {
  it('defers offscreen counters behind a once-trigger', () => {
    document.body.innerHTML = `<span data-count-to="30" data-count-suffix="+">30+</span>`;
    placeOffscreen(document.querySelector('span'));
    const cleanup = initScrollFx(document);
    expect(ScrollTrigger.getAll().length).toBe(1);
    cleanup();
    expect(ScrollTrigger.getAll().length).toBe(0);
  });

  it('starts ticking immediately for in-view counters (fail-safe: static text until then)', () => {
    document.body.innerHTML = `<span data-count-to="30" data-count-suffix="+">30+</span>`;
    const el = document.querySelector('span');
    const cleanup = initScrollFx(document); // jsdom top=0 → in view
    gsap.ticker.tick();                     // advance one GSAP frame
    expect(el.textContent).toMatch(/^\d+\+$/);
    expect(el.textContent).not.toBe('30+'); // animation owns the text now (counting up)
    cleanup();
  });

  it('ignores junk values and reduced motion leaves the static text untouched', () => {
    document.body.innerHTML = `<span data-count-to="banana">5</span>`;
    const cleanup = initScrollFx(document);
    expect(ScrollTrigger.getAll().length).toBe(0);
    expect(document.querySelector('span').textContent).toBe('5');
    cleanup();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    document.body.innerHTML = `<span data-count-to="30">30</span>`;
    const c2 = initScrollFx(document);
    expect(document.querySelector('span').textContent).toBe('30'); // untouched
    c2();
  });
});

describe('useScrollSpy', () => {
  it('creates one trigger per section and cleans up on unmount', async () => {
    const { renderHook } = await import('@testing-library/react');
    document.body.innerHTML = `<section id="s1">one</section><section id="s2">two</section>`;
    document.querySelectorAll('section').forEach(placeOffscreen);
    const { result, unmount } = renderHook(() => useScrollSpy(['s1', 's2']));
    await new Promise(r => setTimeout(r, 40)); // flush the rAF inside the hook
    expect(ScrollTrigger.getAll().length).toBe(2);
    expect(result.current).toBe('s1');        // defaults to the first section
    unmount();
    expect(ScrollTrigger.getAll().length).toBe(0);
  });

  it('tolerates missing section ids without throwing', async () => {
    const { renderHook } = await import('@testing-library/react');
    document.body.innerHTML = ``;
    const { unmount } = renderHook(() => useScrollSpy(['ghost']));
    await new Promise(r => setTimeout(r, 40));
    expect(ScrollTrigger.getAll().length).toBe(0);
    unmount();
  });
});
