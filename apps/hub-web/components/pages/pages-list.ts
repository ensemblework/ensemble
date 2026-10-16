/** Search, sort and paging for the /pages list. The Pages panel uses the same title match. */

export type PageSort = "edited" | "created" | "title";

export const PAGE_SORTS: ReadonlyArray<{ id: PageSort; label: string }> = [
  { id: "edited", label: "Last edited" },
  { id: "created", label: "Created" },
  { id: "title", label: "Title A–Z" },
];

/** Rows shown at first and added by each "Show more". */
export const PAGE_STEP = 30;

export type ListedPage = { id: string; title: string; parentId?: string | null; updatedAt: string; createdAt?: string };

export function isPageSort(value: string | null | undefined): value is PageSort {
  return value === "edited" || value === "created" || value === "title";
}

/** Case-insensitive, and an empty query matches everything. */
export function titleMatches(title: string, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  return !wanted || (title || "Untitled").toLowerCase().includes(wanted);
}

function time(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function sortPages<T extends ListedPage>(pages: readonly T[], sort: PageSort): T[] {
  const rows = [...pages];
  if (sort === "title") return rows.sort((a, b) => collator.compare(a.title || "Untitled", b.title || "Untitled") || a.id.localeCompare(b.id));
  const key = sort === "created" ? (page: T) => time(page.createdAt ?? page.updatedAt) : (page: T) => time(page.updatedAt);
  return rows.sort((a, b) => key(b) - key(a) || a.id.localeCompare(b.id));
}

/**
 * Pages for a query: title matches first, then pages that only match in their text
 * (`textHits`, id → snippet, from the server). Each group keeps the chosen sort.
 */
export function searchPages<T extends ListedPage>(
  pages: readonly T[],
  query: string,
  sort: PageSort,
  textHits: ReadonlyMap<string, string> = new Map(),
): Array<T & { snippet?: string }> {
  const sorted = sortPages(pages, sort);
  if (!query.trim()) return sorted;
  const byTitle = sorted.filter((page) => titleMatches(page.title, query));
  const titled = new Set(byTitle.map((page) => page.id));
  const byText = sorted.filter((page) => !titled.has(page.id) && textHits.has(page.id)).map((page) => ({ ...page, snippet: textHits.get(page.id) || undefined }));
  return [...byTitle, ...byText];
}

/** "Parent › Child" for a nested page, without the page itself. Empty for a top-level page. */
export function parentTrail(page: ListedPage, byId: ReadonlyMap<string, ListedPage>): string {
  const names: string[] = [];
  const seen = new Set([page.id]);
  let parent = page.parentId ? byId.get(page.parentId) : undefined;
  while (parent && !seen.has(parent.id) && names.length < 4) {
    names.unshift(parent.title || "Untitled");
    seen.add(parent.id);
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  return names.join(" › ");
}
