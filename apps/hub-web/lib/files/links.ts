/** Files shows the person's own files, or what Ensemble keeps from their connected apps. */
export type FilesView = "files" | "apps";

/** The address of a Files view; `item` opens one item from an app in the reader. */
export function filesHref(view: FilesView, item?: string | null): string {
  if (view === "files") return "/files";
  return item ? `/files?view=apps&item=${encodeURIComponent(item)}` : "/files?view=apps";
}
