/** Quote marks inside the label's own quotes, apart from the closing (or opening) one. */
const INNER_OPEN = /["“«»]/;
const INNER_CLOSE = /["”«»]/;
const MAX_TITLE = 60;

/**
 * Undo labels quote a title (`Edited “Plan”`). A title that already has quotes is not quoted
 * twice, and a long title is cut so the toast that shows the label stays short.
 */
export function tidyUndoLabel(label: string): string {
  return label
    .replace(new RegExp(`“\\s*${INNER_OPEN.source}+`, "g"), "“")
    .replace(new RegExp(`${INNER_CLOSE.source}+\\s*”`, "g"), "”")
    .replace(/“([^”]*)”/g, (whole, title: string) => {
      const characters = Array.from(title);
      return characters.length > MAX_TITLE ? `“${characters.slice(0, MAX_TITLE - 1).join("").trimEnd()}…”` : whole;
    })
    .slice(0, 240);
}
