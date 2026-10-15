/** What a page row dragged out of the Pages browser carries, besides its plain link. */
export const PAGE_DRAG_TYPE = "application/x-ensemble-page";

export type DraggedPage = { id: string; title: string };

const PAGE_PATH = /^\/pages\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/** The page an in-app address points at (`/pages/<id>`, or a full address on this origin), or null. */
export function pageIdFromHref(href: string, origin: string): string | null {
  let path = href.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.origin !== origin) return null;
      path = url.pathname;
    } catch {
      return null;
    }
  } else path = path.split(/[?#]/)[0]!;
  return PAGE_PATH.exec(path)?.[1] ?? null;
}

export function readDraggedPage(data: DataTransfer | null): DraggedPage | null {
  const raw = data?.getData(PAGE_DRAG_TYPE);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { id?: unknown; title?: unknown };
    return typeof value.id === "string" && value.id ? { id: value.id, title: typeof value.title === "string" ? value.title : "" } : null;
  } catch {
    return null;
  }
}
