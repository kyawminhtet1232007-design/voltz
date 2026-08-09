import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ToastHost, notify, dismissToast, confirmDialog, _resetNotify, _getNotifyState } from './notify.jsx';

beforeEach(() => {
  vi.useFakeTimers();
  _resetNotify();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('notify (toast)', () => {
  it('renders a toast in the host and auto-dismisses after its duration', () => {
    render(<ToastHost />);
    act(() => { notify('Saved successfully', { level: 'success', duration: 4000 }); });
    expect(screen.getByText('Saved successfully')).toBeInTheDocument();
    // Auto-dismiss: advance past the duration
    act(() => { vi.advanceTimersByTime(4100); });
    expect(screen.queryByText('Saved successfully')).not.toBeInTheDocument();
  });

  it('stacks multiple toasts and caps the stack at 5 (drops oldest)', () => {
    render(<ToastHost />);
    act(() => { for (let i = 1; i <= 7; i++) notify(`toast-${i}`, { duration: 0 }); });
    expect(_getNotifyState().toasts).toHaveLength(5);
    expect(screen.queryByText('toast-1')).not.toBeInTheDocument(); // oldest dropped
    expect(screen.getByText('toast-7')).toBeInTheDocument();       // newest kept
  });

  it('dismisses a toast on click', () => {
    render(<ToastHost />);
    act(() => { notify('click me away', { duration: 0 }); });
    fireEvent.click(screen.getByText('click me away'));
    expect(screen.queryByText('click me away')).not.toBeInTheDocument();
  });

  it('announces info/success toasts in the persistent polite live region', () => {
    render(<ToastHost />);
    act(() => { notify('a11y check', { duration: 0 }); });
    expect(screen.getByRole('status')).toHaveTextContent('a11y check');
  });

  // Review fix: errors must interrupt (assertive), not queue politely
  it('routes error toasts to the assertive role=alert region', () => {
    render(<ToastHost />);
    act(() => { notify('upload failed', { level: 'error', duration: 0 }); });
    expect(screen.getByRole('alert')).toHaveTextContent('upload failed');
    expect(screen.getByRole('status')).not.toHaveTextContent('upload failed');
  });

  // Review fix: sticky toasts were keyboard-immortal without a real dismiss button
  it('every toast has a focusable, labelled dismiss button', () => {
    render(<ToastHost />);
    act(() => { notify('sticky note', { duration: 0 }); });
    fireEvent.click(screen.getByLabelText('Dismiss notification'));
    expect(screen.queryByText('sticky note')).not.toBeInTheDocument();
  });

  it('dismissToast on an unknown id is a no-op (does not throw or re-render)', () => {
    render(<ToastHost />);
    expect(() => act(() => dismissToast('nope'))).not.toThrow();
  });
});

describe('confirmDialog', () => {
  it('renders an alertdialog and resolves true on confirm', async () => {
    render(<ToastHost />);
    let result;
    act(() => { confirmDialog({ title: 'Reset data?', confirmLabel: 'Reset' }).then(r => { result = r; }); });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Reset'));
    await act(async () => {}); // flush the promise
    expect(result).toBe(true);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('resolves false on cancel', async () => {
    render(<ToastHost />);
    let result;
    act(() => { confirmDialog({ title: 'Sure?', cancelLabel: 'Keep editing' }).then(r => { result = r; }); });
    fireEvent.click(screen.getByText('Keep editing'));
    await act(async () => {});
    expect(result).toBe(false);
  });

  it('resolves false on Escape (keyboard a11y)', async () => {
    render(<ToastHost />);
    let result;
    act(() => { confirmDialog({ title: 'Esc test' }).then(r => { result = r; }); });
    fireEvent.keyDown(window, { key: 'Escape' });
    await act(async () => {});
    expect(result).toBe(false);
  });

  it('resolves false on backdrop click', async () => {
    render(<ToastHost />);
    let result;
    act(() => { confirmDialog({ title: 'Backdrop test' }).then(r => { result = r; }); });
    fireEvent.click(screen.getByRole('presentation')); // the backdrop itself
    await act(async () => {});
    expect(result).toBe(false);
  });

  it('a second dialog cancels the first so its caller never hangs', async () => {
    render(<ToastHost />);
    let first;
    act(() => { confirmDialog({ title: 'First' }).then(r => { first = r; }); });
    act(() => { confirmDialog({ title: 'Second' }); });
    await act(async () => {});
    expect(first).toBe(false); // first promise settled, not orphaned
    expect(screen.getByRole('alertdialog')).toHaveAccessibleName('Second');
  });

  // ── Review-fix regression tests ────────────────────────────────────────────

  it('danger dialogs focus Cancel first (a reflexive Enter must not destroy data)', () => {
    render(<ToastHost />);
    act(() => { confirmDialog({ title: 'Reset?', danger: true, cancelLabel: 'Keep', confirmLabel: 'Reset' }); });
    expect(document.activeElement).toBe(screen.getByText('Keep'));
  });

  it('non-danger dialogs focus the confirm button', () => {
    render(<ToastHost />);
    act(() => { confirmDialog({ title: 'Proceed?', confirmLabel: 'Go' }); });
    expect(document.activeElement).toBe(screen.getByText('Go'));
  });

  it('traps Tab inside the dialog (focus cycles between the two buttons)', () => {
    render(<ToastHost />);
    act(() => { confirmDialog({ title: 'Trap?', cancelLabel: 'No', confirmLabel: 'Yes' }); });
    const dialog = screen.getByRole('alertdialog');
    expect(document.activeElement).toBe(screen.getByText('Yes'));
    fireEvent.keyDown(dialog, { key: 'Tab' });            // wraps Yes -> No
    expect(document.activeElement).toBe(screen.getByText('No'));
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true }); // back No -> Yes
    expect(document.activeElement).toBe(screen.getByText('Yes'));
  });

  it('returns focus to the triggering element after close (WCAG 2.4.3)', async () => {
    render(
      <>
        <button>trigger</button>
        <ToastHost />
      </>
    );
    const trigger = screen.getByText('trigger');
    trigger.focus();
    act(() => { confirmDialog({ title: 'Focus return?' }); });
    expect(document.activeElement).not.toBe(trigger); // moved into dialog
    fireEvent.click(screen.getByText('Confirm'));
    await act(async () => {});
    expect(document.activeElement).toBe(trigger);     // and back
  });

  it('exposes the message as the accessible description (aria-describedby)', () => {
    render(<ToastHost />);
    act(() => { confirmDialog({ title: 'Reset?', message: 'This permanently clears everything.' }); });
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription('This permanently clears everything.');
  });

  it('locks body scroll while open and restores it on close', async () => {
    render(<ToastHost />);
    act(() => { confirmDialog({ title: 'Scroll lock?' }); });
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(screen.getByText('Cancel'));
    await act(async () => {});
    expect(document.body.style.overflow).toBe('');
  });
});
