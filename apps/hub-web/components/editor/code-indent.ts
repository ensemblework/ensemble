import { Extension, type Editor } from "@tiptap/core";

const INDENT = "  ";

/**
 * Tab and Shift+Tab inside a code block indent and outdent instead of moving focus out of the
 * page (where the next keys would be lost). With a selection, every selected line moves.
 * Lists keep their own Tab (nest) everywhere else.
 */
function indentCode(editor: Editor, outdent: boolean): boolean {
  const { $from, $to, empty } = editor.state.selection;
  if ($from.parent.type.name !== "codeBlock" || !$from.sameParent($to)) return false;
  if (!outdent && empty) return editor.commands.command(({ tr }) => Boolean(tr.insertText(INDENT)));
  const text = $from.parent.textContent;
  const start = $from.start();
  const from = $from.parentOffset;
  // A selection that ends at the very start of a line does not take that line along.
  const to = !empty && $to.parentOffset > from && text[$to.parentOffset - 1] === "\n" ? $to.parentOffset - 1 : $to.parentOffset;
  const lines: number[] = [text.lastIndexOf("\n", from - 1) + 1];
  for (let at = text.indexOf("\n", from); at !== -1 && at < to; at = text.indexOf("\n", at + 1)) lines.push(at + 1);
  return editor.commands.command(({ tr }) => {
    let changed = false;
    for (const line of lines.reverse()) {
      if (!outdent) {
        tr.insertText(INDENT, start + line);
        changed = true;
        continue;
      }
      const lead = /^( {1,2}|\t)/.exec(text.slice(line))?.[0].length ?? 0;
      if (!lead) continue;
      tr.delete(start + line, start + line + lead);
      changed = true;
    }
    return changed || outdent;
  });
}

export const CodeIndent = Extension.create({
  name: "codeIndent",
  priority: 200,
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => indentCode(editor, false),
      "Shift-Tab": ({ editor }) => indentCode(editor, true),
    };
  },
});
