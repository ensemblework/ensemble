export type SearchPhase = "idle" | "typing" | "searching" | "results" | "empty";

/**
 * Which search.query state to paint.
 * `pending` is real in-flight work. A cached query passes false, so it never
 * becomes "searching". `showLoader` is the shared delay policy (already past
 * 180 ms, and held). An unknown count must not claim the list is empty.
 */
export function searchPhase(input: {
  focused: boolean;
  query: string;
  pending: boolean;
  showLoader: boolean;
  /** Null while the outcome is not known yet. */
  count: number | null;
  /** When true, a non-zero count paints the results list. */
  list: boolean;
}): SearchPhase {
  const typed = input.query.trim().length > 0;
  if (input.pending && input.showLoader) return "searching";
  if (typed && input.count === 0 && !input.pending) return "empty";
  if (input.list && input.count !== null && input.count > 0) return "results";
  if (input.focused || typed) return "typing";
  return "idle";
}
