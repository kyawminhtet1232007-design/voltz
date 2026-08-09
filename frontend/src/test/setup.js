// Vitest global setup. Adds jest-dom matchers (toBeInTheDocument, etc.) and
// silences expected console noise from intentional error-path tests.
import '@testing-library/jest-dom';

// jsdom's matchMedia (when present at all) lacks the listener methods GSAP's
// ScrollTrigger calls during registerPlugin (mq.addListener/addEventListener).
// Provide a complete, inert implementation so modules that import GSAP can be
// tested. Individual tests still override this with vi.stubGlobal as needed.
window.matchMedia = (query) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});
