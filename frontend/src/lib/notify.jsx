// ── notify.jsx ───────────────────────────────────────────────────────────────
// Styled toast + async confirm dialog replacing native alert()/window.confirm().
//
// Rationale (refinement step): native dialogs block the JS thread, clash with
// the app's styling, and window.confirm for destructive actions is too easy to
// misclick. This module provides:
//   - notify(message, {level, duration})  → non-blocking toast
//   - confirmDialog({title, message, ...}) → Promise<boolean> styled modal
//   - <ToastHost/>                         → mounted ONCE in the app shell
//
// Design: a module-level store (not React context) so any call site inside the
// 12k-line VexHub.jsx can fire a toast with a one-line change — keeping the
// refactor surgical. ToastHost subscribes to the store and renders.
//
// Post-review hardening (adversarial a11y review findings, all applied here):
//   - Tab is trapped inside the confirm dialog (aria-modal without a trap lets
//     keyboard focus reach content SRs are told doesn't exist).
//   - Focus returns to the triggering element on close (WCAG 2.4.3).
//   - danger dialogs focus Cancel first, so a reflexive Enter can't fire the
//     destructive action.
//   - Title/message wired via aria-labelledby/aria-describedby so SRs announce
//     the consequence text, not just the button label.
//   - Confirm blue #2563eb (was #3b82f6, ~3.7:1 — below AA for 13px text).
//   - Every toast has a focusable "Dismiss notification" button (click-anywhere
//     stays as a mouse bonus); sticky toasts are no longer keyboard-immortal.
//   - One persistent polite live region for info/success and one assertive
//     region for errors — no nested per-item live regions (double-announce bug).
//   - Toast stack zIndex sits ABOVE the modal backdrop; bottom offset respects
//     env(safe-area-inset-bottom); body scroll locks while the dialog is open.

import React from "react";
import { createLogger } from "./logger.js";

const nLog = createLogger("notify");

// ── Module store ─────────────────────────────────────────────────────────────
const listeners = new Set();
let state = { toasts: [], confirm: null };
const MAX_TOASTS = 5; // cap the stack so a notify() loop can't flood the screen

function setState(next) {
  state = next;
  listeners.forEach((l) => l(state));
}

// Test hooks — lets unit tests reset module state between cases.
export function _resetNotify() { state = { toasts: [], confirm: null }; listeners.forEach((l) => l(state)); }
export function _getNotifyState() { return state; }

// ── Public API ───────────────────────────────────────────────────────────────

// Fire a toast. level: "info" | "success" | "error". duration 0 = sticky.
export function notify(message, { level = "info", duration = 4000 } = {}) {
  nLog.debug("notify:enter", { message: String(message), level }); // entry trace
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  setState({ ...state, toasts: [...state.toasts, { id, message: String(message), level }].slice(-MAX_TOASTS) });
  if (duration > 0) setTimeout(() => dismissToast(id), duration);
  return id;
}

export function dismissToast(id) {
  if (!state.toasts.some((t) => t.id === id)) return;
  setState({ ...state, toasts: state.toasts.filter((t) => t.id !== id) });
}

// Styled replacement for window.confirm — resolves true/false, never blocks the thread.
export function confirmDialog({ title = "Are you sure?", message = "", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false } = {}) {
  nLog.debug("confirmDialog:enter", { title }); // entry trace
  return new Promise((resolve) => {
    // If a dialog is somehow already open, resolve it as cancelled first so its
    // caller never hangs awaiting a promise that can no longer settle.
    if (state.confirm) state.confirm.close(false);
    // Review fix (WCAG 2.4.3): remember the trigger so focus can return to it.
    const returnFocusEl = typeof document !== "undefined" ? document.activeElement : null;
    const close = (result) => {
      nLog.debug("confirmDialog:exit", { title, result }); // exit trace with outcome
      setState({ ...state, confirm: null });
      if (returnFocusEl?.isConnected && typeof returnFocusEl.focus === "function") returnFocusEl.focus();
      resolve(result);
    };
    setState({ ...state, confirm: { title, message, confirmLabel, cancelLabel, danger, close } });
  });
}

// ── Host component (mount once in the app shell) ─────────────────────────────
const LEVEL_STYLE = {
  info:    { border: "#3b82f6", icon: "ℹ" },
  success: { border: "#10b981", icon: "✓" },
  error:   { border: "#ef4444", icon: "!" },
};

function Toast({ t }) {
  const st = LEVEL_STYLE[t.level] || LEVEL_STYLE.info;
  return (
    <div onClick={() => dismissToast(t.id)}
      style={{ pointerEvents: "auto", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, background: "#111827", color: "#e5e7eb", border: `1px solid ${st.border}`, borderLeft: `4px solid ${st.border}`, borderRadius: 12, padding: "10px 14px", fontSize: 13, lineHeight: 1.45, boxShadow: "0 10px 30px rgba(0,0,0,0.45)", animation: "vexToastIn 0.25s cubic-bezier(0.22,1,0.36,1) both" }}>
      <span aria-hidden="true" style={{ color: st.border, fontWeight: 800, flexShrink: 0 }}>{st.icon}</span>
      <span>{t.message}</span>
      {/* Review fix: explicit focusable dismiss control — click-anywhere is mouse-only,
          and sticky (duration:0) toasts were otherwise immortal for keyboard/SR users. */}
      <button aria-label="Dismiss notification" onClick={(e) => { e.stopPropagation(); dismissToast(t.id); }}
        style={{ background: "transparent", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "2px 4px", flexShrink: 0 }}>
        ✕
      </button>
    </div>
  );
}

export function ToastHost() {
  const [s, setS] = React.useState(state);
  React.useEffect(() => {
    listeners.add(setS);
    setS(state); // sync anything fired before mount
    return () => listeners.delete(setS);
  }, []);

  const confirmBtnRef = React.useRef(null);
  const cancelBtnRef  = React.useRef(null);
  const titleId = React.useId();
  const msgId   = React.useId();

  React.useEffect(() => {
    if (!s.confirm) return;
    // Review fix: danger dialogs focus Cancel so a reflexive Enter can't destroy data.
    (s.confirm.danger ? cancelBtnRef : confirmBtnRef).current?.focus();
    const onKey = (e) => { if (e.key === "Escape") s.confirm.close(false); };
    window.addEventListener("keydown", onKey);
    // Review fix: lock background scroll while the modal is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prevOverflow; };
  }, [s.confirm]);

  // Review fix: trap Tab between the dialog's two buttons — aria-modal hides the
  // background from SRs, so focus must never reach it.
  const onDialogKeyDown = (e) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const els = [cancelBtnRef.current, confirmBtnRef.current].filter(Boolean);
    if (!els.length) return;
    const idx = els.indexOf(document.activeElement);
    const next = e.shiftKey ? (idx <= 0 ? els.length - 1 : idx - 1) : (idx >= els.length - 1 ? 0 : idx + 1);
    els[next]?.focus();
  };

  const politeToasts = s.toasts.filter((t) => t.level !== "error");
  const errorToasts  = s.toasts.filter((t) => t.level === "error");

  return (
    <>
      {/* Toast stack. zIndex above the modal backdrop (review fix: toasts fired while
          a confirm is open were dimmed + unclickable behind it). Two PERSISTENT live
          regions — polite for info/success, assertive for errors — with no per-item
          live roles (nested live regions double-announce on NVDA/JAWS). */}
      <div style={{ position: "fixed", bottom: "calc(24px + env(safe-area-inset-bottom, 0px))", left: "50%", transform: "translateX(-50%)", zIndex: 10001, display: "flex", flexDirection: "column", gap: 8, alignItems: "center", pointerEvents: "none", maxWidth: "min(92vw, 480px)" }}>
        <div role="status" aria-live="polite" style={{ display: "contents" }}>
          {politeToasts.map((t) => <Toast key={t.id} t={t} />)}
        </div>
        <div role="alert" aria-live="assertive" style={{ display: "contents" }}>
          {errorToasts.map((t) => <Toast key={t.id} t={t} />)}
        </div>
        <style>{`@keyframes vexToastIn { from { opacity:0; transform:translateY(8px);} to { opacity:1; transform:translateY(0);} }`}</style>
      </div>

      {/* Confirm modal — alertdialog semantics, backdrop click = cancel */}
      {s.confirm && (
        <div role="presentation" onClick={() => s.confirm.close(false)}
          style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          {/* Review fix: labelledby/describedby so SRs announce the consequence text,
              not just "<title>, dialog. <button>". */}
          <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={s.confirm.message ? msgId : undefined}
            onClick={(e) => e.stopPropagation()} onKeyDown={onDialogKeyDown}
            style={{ width: "100%", maxWidth: 400, background: "#111827", border: "1px solid #1f2937", borderRadius: 16, padding: "22px 22px 18px", color: "#e5e7eb", boxShadow: "0 30px 80px rgba(0,0,0,0.6)" }}>
            <h2 id={titleId} style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>{s.confirm.title}</h2>
            {s.confirm.message && <p id={msgId} style={{ margin: "8px 0 0", fontSize: 13, color: "#9ca3af", lineHeight: 1.55 }}>{s.confirm.message}</p>}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18 }}>
              <button ref={cancelBtnRef} onClick={() => s.confirm.close(false)}
                style={{ background: "transparent", color: "#9ca3af", border: "1px solid #374151", borderRadius: 10, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                {s.confirm.cancelLabel}
              </button>
              {/* Review fix: #2563eb (≈5.2:1) — #3b82f6 was ~3.7:1, below AA at 13px */}
              <button ref={confirmBtnRef} onClick={() => s.confirm.close(true)}
                style={{ background: s.confirm.danger ? "#dc2626" : "#2563eb", color: "#fff", border: "none", borderRadius: 10, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                {s.confirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
