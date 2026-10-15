const QUOTES = /["“”«»]/;
const MAX_TITLE = 60;

/**
 * Undo labels quote a title (`Edited “Plan”`). A title that already has quotes is not quoted
 * twice, and a long title is cut so the toast that shows the label stays short.
 */
export function tidyUndoLabel(label: string): string {
  return label
    .replace(new RegExp(`“\\s*${QUOTES.source}+`, "g"), "“")
    .replace(new RegExp(`${QUOTES.source}+\\s*”`, "g"), "”")
    .replace(/“([^”]*)”/g, (whole, title: string) => {
      const characters = Array.from(title);
      return characters.length > MAX_TITLE ? `“${characters.slice(0, MAX_TITLE - 1).join("").trimEnd()}…”` : whole;
    })
    .slice(0, 240);
}
