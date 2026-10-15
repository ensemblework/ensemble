/** Marks a page's body editor, so the title above it can hand it the caret. */
export const PAGE_BODY_ATTRIBUTE = "data-page-body";

type FocusableEditor = { commands: { focus: (position: "start") => boolean } };

/**
 * Moves the caret to the start of the page body that follows `from` (the title field). TipTap
 * keeps its editor on the editor element. False when there is no editable body yet.
 */
export function focusPageBody(from: Element): boolean {
  for (let scope = from.parentElement; scope; scope = scope.parentElement) {
    const body = Array.from(scope.querySelectorAll<HTMLElement>(`[${PAGE_BODY_ATTRIBUTE}][contenteditable="true"]`)).find(
      (element) => from.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    if (!body) continue;
    const editor = (body as HTMLElement & { editor?: FocusableEditor }).editor;
    if (editor) editor.commands.focus("start");
    else body.focus();
    return true;
  }
  return false;
}
