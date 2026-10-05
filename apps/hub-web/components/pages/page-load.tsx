"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

/** A 404 is gone. Any other failure, including offline, can be retried. */
export function PageLoadFailure({ missing, onRetry }: { missing: boolean; onRetry: () => void }) {
  if (missing) return <div className="p-10 text-muted">This page no longer exists.</div>;
  return (
    <div className="p-10 text-muted">
      <p>Couldn't load this page</p>
      <button type="button" className="btn mt-3" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
