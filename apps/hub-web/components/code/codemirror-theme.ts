import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags, type Tag } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { IdeTheme, TokenRole } from "@ensemble/ide-theme";

const ROLE_TAGS: Record<TokenRole, Tag | readonly Tag[]> = {
  comment: tags.comment,
  string: tags.string,
  number: tags.number,
  keyword: tags.keyword,
  controlKeyword: tags.controlKeyword,
  operator: tags.operator,
  function: tags.function(tags.variableName),
  type: tags.typeName,
  className: tags.className,
  tag: tags.tagName,
  attribute: tags.attributeName,
  variable: tags.variableName,
  property: tags.propertyName,
  constant: [tags.atom, tags.bool, tags.null],
  regexp: tags.regexp,
  punctuation: tags.punctuation,
  invalid: tags.invalid,
  heading: tags.heading,
  emphasis: tags.emphasis,
  strong: tags.strong,
  link: tags.link,
  inserted: tags.inserted,
  deleted: tags.deleted,
};

/** Map a converted VS Code theme onto CodeMirror. The input is already sanitized. */
export function codeMirrorTheme(theme: IdeTheme): Extension[] {
  const editor = theme.editor;
  if (!editor) return [];
  const highlight = HighlightStyle.define(
    theme.tokens.flatMap((token) => {
      const tag = ROLE_TAGS[token.role];
      if (!tag) return [];
      const font = fontAttrs(token.fontStyle);
      return [{ tag, ...(token.color ? { color: token.color } : {}), ...font }];
    }),
  );
  const chrome = EditorView.theme(
    {
      "&": { backgroundColor: editor.background, color: editor.foreground },
      ".cm-content": { caretColor: editor.caret },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: editor.caret },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: editor.selection,
      },
      ".cm-selectionMatch": { backgroundColor: editor.selectionMatch },
      ".cm-activeLine": { backgroundColor: editor.lineHighlight },
      ".cm-gutters": {
        backgroundColor: editor.gutterBackground,
        color: editor.gutterForeground,
        borderRight: `1px solid ${editor.gutterBorder}`,
      },
      ".cm-activeLineGutter": { backgroundColor: editor.lineHighlight, color: editor.gutterActiveForeground },
    },
    { dark: theme.kind !== "light" },
  );
  return [chrome, syntaxHighlighting(highlight)];
}

function fontAttrs(fontStyle: string | undefined): { fontStyle?: string; fontWeight?: string; textDecoration?: string } {
  if (!fontStyle) return {};
  const parts = fontStyle.split(" ");
  const deco = [parts.includes("underline") ? "underline" : "", parts.includes("strikethrough") ? "line-through" : ""].filter(Boolean);
  return {
    ...(parts.includes("italic") ? { fontStyle: "italic" } : {}),
    ...(parts.includes("bold") ? { fontWeight: "bold" } : {}),
    ...(deco.length ? { textDecoration: deco.join(" ") } : {}),
  };
}
