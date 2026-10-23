export const boardHref = (id: string) => `/board?board=${encodeURIComponent(id)}`;
export const boardPageHref = (page: { kind?: "page" | "task"; id: string }) => `/${page.kind === "task" ? "tasks" : "pages"}/${page.id}`;

export function groupBoardPages<T extends { board?: { id: string; title: string } | null }>(pages: readonly T[]) {
  const independent: T[] = [];
  const byBoard = new Map<string, { id: string; title: string; pages: T[] }>();
  for (const page of pages) {
    if (!page.board) { independent.push(page); continue; }
    let group = byBoard.get(page.board.id);
    if (!group) { group = { ...page.board, pages: [] }; byBoard.set(group.id, group); }
    group.pages.push(page);
  }
  return { independent, boards: [...byBoard.values()].sort((a, b) => a.id === "ensemble" ? -1 : b.id === "ensemble" ? 1 : a.title.localeCompare(b.title)) };
}
