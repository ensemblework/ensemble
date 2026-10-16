"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { CloudOff, RefreshCw, ServerCrash, TriangleAlert } from "lucide-react";
import { describeLoadFailure } from "@/lib/load-failure";
import { cx } from "./ui";

/**
 * A screen whose data failed to load: says whether Ensemble is unreachable or its
 * server failed, and offers Retry. Use it instead of leaving skeletons or an empty
 * state up when a query errors.
 */
export function LoadError({
  error,
  onRetry,
  what = "this",
  retrying = false,
  compact = false,
  className,
  children,
}: {
  error: unknown;
  onRetry: () => void;
  /** What failed to load, as it reads after "Couldn't load": "the board", "your files". */
  what?: string;
  /** The retry is in flight: the button waits. */
  retrying?: boolean;
  /** A tile or a panel rather than a whole screen. */
  compact?: boolean;
  className?: string;
  /** Extra actions beside Retry. */
  children?: React.ReactNode;
}) {
  const { kind, title, detail } = describeLoadFailure(error, what);
  const Icon = kind === "offline" ? CloudOff : kind === "server" ? ServerCrash : TriangleAlert;
  return (
    <div
      role="alert"
      data-load-error={kind}
      className={cx(
        "rounded-xl border border-line bg-panel text-[13px]",
        compact ? "p-3" : "mx-auto my-6 max-w-lg p-5",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <Icon size={compact ? 16 : 18} className="mt-0.5 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-ink">{title}</p>
          <p className="mt-1 text-muted">{detail}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className="btn" onClick={onRetry} disabled={retrying} aria-busy={retrying || undefined}>
              <RefreshCw size={13} className={retrying ? "animate-spin" : undefined} aria-hidden />
              {retrying ? "Retrying…" : "Retry"}
            </button>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
