"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import Link from "next/link";
import { LoadError } from "../load-error";

/**
 * A page or task that is not there. A 404 is worded for both a deleted item and a
 * link that never pointed at one, and offers a way back; anything else can be retried.
 */
export function PageLoadFailure({
  missing,
  onRetry,
  kind = "page",
  error,
  retrying = false,
  links = true,
}: {
  missing: boolean;
  onRetry: () => void;
  kind?: "page" | "task";
  error?: unknown;
  retrying?: boolean;
  /** False on a shared item or public link: Pages, the board and Trash are not yours to open. */
  links?: boolean;
}) {
  if (!missing) return <LoadError error={error ?? new Error("Something went wrong.")} what={`this ${kind}`} retrying={retrying} onRetry={onRetry} />;
  const back = kind === "page" ? { href: "/pages", label: "Go to Pages" } : { href: "/board", label: "Go to the board" };
  return (
    <div role="alert" className="mx-auto my-10 max-w-lg rounded-xl border border-line bg-panel p-5 text-[13.5px]">
      <h1 className="text-[16px] font-semibold text-ink">{kind === "page" ? "Page not found" : "Task not found"}</h1>
      <p className="mt-1 text-muted">
        There is no {kind} at this address. It may have been deleted for good, or the link may be wrong.
      </p>
      {links ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Link href={back.href} className="btn-primary">{back.label}</Link>
          <Link href="/trash" className="btn">Open Trash</Link>
        </div>
      ) : null}
    </div>
  );
}

/** True when the API said the item is in Trash rather than gone. */
export function inTrash(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "PAGE_IN_TRASH" || code === "TASK_IN_TRASH";
}
