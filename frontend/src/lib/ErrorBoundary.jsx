// ── ErrorBoundary.jsx ────────────────────────────────────────────────────────
// App-level error boundary. Previously the only boundary was GlbErrorBoundary
// (scoped to 3D models), so a single uncaught render error anywhere else
// white-screened the entire SPA. This catches those, logs them with full
// component stack, and offers the user a recovery path instead of a blank page.

import React from "react";
import { createLogger, getLogBuffer } from "./logger.js";

const logErr = createLogger("error-boundary");

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface the crash (the app had no error logging at all before this).
    logErr.error("Uncaught render error", {
      message: error?.message,
      stack: error?.stack,
      componentStack: info?.componentStack,
    });
  }

  handleReload = () => window.location.reload();

  handleReset = () => this.setState({ error: null });

  // Let the user copy a diagnostic bundle (error + recent log ring) for bug reports.
  handleCopyDiagnostics = async () => {
    const payload = {
      error: { message: this.state.error?.message, stack: this.state.error?.stack },
      logs: getLogBuffer().slice(-50),
      when: new Date().toISOString(),
      ua: navigator.userAgent,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      // eslint-disable-next-line no-alert
    } catch { /* clipboard may be blocked; nothing else to do */ }
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div style={{
        minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        background: "#0b1220", color: "#e5e7eb", padding: 24, fontFamily: "system-ui, sans-serif",
      }}>
        <div style={{ maxWidth: 460, textAlign: "center" }}>
          <div style={{ fontSize: 44, marginBottom: 12 }}>⚠️</div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 8px" }}>Something went wrong</h1>
          <p style={{ fontSize: 14, color: "#9ca3af", lineHeight: 1.6, margin: "0 0 20px" }}>
            The page hit an unexpected error. Your data is safe — try reloading, or
            go back to the home screen.
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <button onClick={this.handleReload} style={btn("#dc2626")}>Reload page</button>
            <button onClick={this.handleReset} style={btn("#374151")}>Try again</button>
            <button onClick={this.handleCopyDiagnostics} style={btn("transparent", "#374151")}>
              Copy diagnostics
            </button>
          </div>
          {import.meta?.env?.DEV && (
            <pre style={{
              marginTop: 20, textAlign: "left", fontSize: 11, color: "#f87171",
              background: "#111827", border: "1px solid #1f2937", borderRadius: 8,
              padding: 12, overflow: "auto", maxHeight: 200,
            }}>{this.state.error?.stack || this.state.error?.message}</pre>
          )}
        </div>
      </div>
    );
  }
}

function btn(bg, border) {
  return {
    background: bg, color: "#fff", border: border ? `1px solid ${border}` : "none",
    borderRadius: 10, padding: "10px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer",
  };
}
