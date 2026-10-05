/** In-app path for a standalone note. Never an API address. */
export function standalonePageHref(id: string, focusTitle = false): string {
  const path = `/pages/${id}`;
  return focusTitle ? `${path}?focus=title` : path;
}
