import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary.jsx';
import { getLogBuffer, clearLogBuffer } from './logger.js';

// A component that throws on demand to trigger the boundary.
function Bomb({ boom }) {
  if (boom) throw new Error('kaboom');
  return <div>safe content</div>;
}

beforeEach(() => {
  clearLogBuffer();
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('renders children when there is no error', () => {
    render(<ErrorBoundary><Bomb boom={false} /></ErrorBoundary>);
    expect(screen.getByText('safe content')).toBeInTheDocument();
  });

  it('catches a render error and shows the recovery UI', () => {
    // React logs the error to console.error; silence it for a clean test run.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary><Bomb boom={true} /></ErrorBoundary>);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('Reload page')).toBeInTheDocument();
  });

  it('logs the crash to the logger ring buffer', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary><Bomb boom={true} /></ErrorBoundary>);
    const errs = getLogBuffer().filter(e => e.level === 'error');
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some(e => e.message.includes('Uncaught render error'))).toBe(true);
  });

  it('"Try again" resets the boundary so a recovered child renders', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The child reads a module-level flag so the SAME element can stop throwing
    // before the boundary resets — mirroring a real transient error clearing.
    let shouldThrow = true;
    function MaybeBomb() {
      if (shouldThrow) throw new Error('transient');
      return <div>recovered content</div>;
    }
    render(<ErrorBoundary><MaybeBomb /></ErrorBoundary>);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    shouldThrow = false;              // the underlying cause is now gone
    fireEvent.click(screen.getByText('Try again'));
    expect(screen.getByText('recovered content')).toBeInTheDocument();
  });
});
