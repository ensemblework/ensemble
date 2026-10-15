import { ApiError, isUnreachable } from "./api";

/** Why a screen's data did not load. Offline and a server error look alike to a person unless the screen says which. */
export type LoadFailureKind = "offline" | "server" | "missing" | "denied" | "other";

export function loadFailureKind(error: unknown): LoadFailureKind {
  if (isUnreachable(error) || (error instanceof ApiError && error.status === 0)) return "offline";
  if (!(error instanceof ApiError)) return error instanceof TypeError ? "offline" : "other";
  if (error.status >= 500) return "server";
  if (error.status === 404) return "missing";
  if (error.status === 401 || error.status === 403) return "denied";
  return "other";
}

/** Heading and one line of detail for a failed load of `what` ("the board", "your files"). */
export function describeLoadFailure(error: unknown, what: string): { kind: LoadFailureKind; title: string; detail: string } {
  const kind = loadFailureKind(error);
  if (kind === "offline") {
    return { kind, title: "Can't reach Ensemble", detail: "Check your connection, then try again. Your work on this computer is kept." };
  }
  if (kind === "server") {
    return { kind, title: `Couldn't load ${what}`, detail: "Ensemble's server ran into a problem. Try again in a moment." };
  }
  const message = error instanceof Error && error.message.trim() ? error.message.trim() : "Something went wrong.";
  return { kind, title: `Couldn't load ${what}`, detail: message };
}
