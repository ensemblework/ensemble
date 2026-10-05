"use client";

import { Component, type ReactNode } from "react";
import { EnsembleMark } from "./brand/Logo";

/** One bad row must not take down the page. */
export class PageErrorBoundary extends Component<{ children: ReactNode; title?: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-line bg-panel p-6">
        <EnsembleMark size={20} />
        <h2 className="mt-3 text-[16px] font-semibold">{this.props.title ?? "This page hit a bad value"}</h2>
        <p className="mt-2 text-[13.5px] text-muted">
          The rest of Ensemble is fine. {this.state.error.message || "Something on this page could not be shown."}
        </p>
        <button type="button" className="btn mt-4" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
