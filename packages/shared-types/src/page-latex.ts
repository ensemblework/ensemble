/**
 * A LaTeX document's common structure as page Markdown, by hand and without a TeX engine:
 * `\section` and its smaller kin become headings, `\textbf`/`\textit`/`\emph`/`\underline` become
 * bold, italics and underline, `itemize`/`enumerate` become lists, `equation`, `align` and `\[…\]`
 * become display equations, and `$…$` stays inline math. A preamble of commands, `%` comments
 * and `\label` are dropped; `\\` breaks a line. Commands it does not know stay as text.
 *
 * Only text that is clearly LaTeX (`looksLikeLatex`) is converted, and every step is a single
 * bounded pass, so ordinary text never changes and large input stays fast.
 */

/** The longest LaTeX document converted; longer text is left as it is. */
export const MAX_LATEX = 400_000;
/** The longest argument read for one command (`\textbf{…}`). */
const MAX_ARGUMENT = 1000;

/** The marker a LaTeX document opens with. */
const LATEX_START = /^\\(?:documentclass\b|begin\{document\}|(?:sub){0,2}section\*?\{|chapter\*?\{)/;
/** Markdown block syntax: with it, the text is Markdown even when it shows LaTeX (a fenced example). */
const MARKDOWN_BLOCKS = /^[ \t]*(?:```|~~~|#{1,6}[ \t]|[-*+][ \t]|\d{1,9}[.)][ \t]|>)/m;

/**
 * Whether text is a LaTeX document: its first line that is not blank or a `%` comment starts with
 * `\documentclass`, `\begin{document}`, `\section{`, `\subsection{`, `\subsubsection{` or
 * `\chapter{`, and it has no Markdown headings, lists, quotes or fences.
 */
export function looksLikeLatex(text: string): boolean {
  if (text.length > MAX_LATEX || MARKDOWN_BLOCKS.test(text)) return false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("%")) continue;
    return LATEX_START.test(trimmed);
  }
  return false;
}

/** The argument in braces starting at `open` (a `{`), with the index after its `}`; null when it does not close in time. */
function argument(text: string, open: number): { value: string; end: number } | null {
  if (text[open] !== "{") return null;
  let depth = 0;
  for (let i = open; i < text.length && i - open <= MAX_ARGUMENT; i += 1) {
    const char = text[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return { value: text.slice(open + 1, i), end: i + 1 };
  }
  return null;
}

const INLINE_COMMANDS: Record<string, (value: string) => string> = {
  textbf: (value) => `**${value.trim()}**`,
  textit: (value) => `*${value.trim()}*`,
  emph: (value) => `*${value.trim()}*`,
  textsl: (value) => `*${value.trim()}*`,
  underline: (value) => `<u>${value.trim()}</u>`,
  texttt: (value) => `\`${value}\``,
  url: (value) => value.trim(),
};

/** Text with `\textbf{…}` and its kin as Markdown marks, outside math. Unknown commands stay. */
function inlineLatex(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (char === "$") {
      // Math passes through untouched: `$…$` and `$$…$$` up to the matching dollars.
      const display = text.startsWith("$$", i);
      const close = text.indexOf(display ? "$$" : "$", i + (display ? 2 : 1));
      if (close > i) {
        const end = close + (display ? 2 : 1);
        out += text.slice(i, end);
        i = end;
        continue;
      }
    }
    if (char === "\\" && text[i + 1] === "$") {
      out += "\\$";
      i += 2;
      continue;
    }
    if (char === "\\") {
      const name = /^\\([A-Za-z]+)\*?/.exec(text.slice(i, i + 40));
      if (name?.[1] === "href") {
        const target = argument(text, i + name[0].length);
        const label = target ? argument(text, target.end) : null;
        if (target && label) {
          out += /^https?:\/\//.test(target.value.trim()) ? `[${inlineLatex(label.value)}](${target.value.trim()})` : inlineLatex(label.value);
          i = label.end;
          continue;
        }
      }
      const convert = name ? INLINE_COMMANDS[name[1]!] : undefined;
      if (name && convert) {
        const arg = argument(text, i + name[0].length);
        if (arg) {
          out += convert(name[1] === "texttt" || name[1] === "url" ? arg.value : inlineLatex(arg.value));
          i = arg.end;
          continue;
        }
      }
      const symbol = text[i + 1];
      if (symbol && "%&#_{}".includes(symbol)) {
        out += symbol;
        i += 2;
        continue;
      }
      if (symbol === "\\") {
        out += "\n";
        i += 2;
        continue;
      }
      if (name && (name[1] === "noindent" || name[1] === "maketitle" || name[1] === "medskip" || name[1] === "bigskip" || name[1] === "smallskip" || name[1] === "newpage" || name[1] === "clearpage" || name[1] === "tableofcontents")) {
        i += name[0].length;
        continue;
      }
    }
    if (char === "~") {
      out += " ";
      i += 1;
      continue;
    }
    if (text.startsWith("``", i)) {
      out += "“";
      i += 2;
      continue;
    }
    if (text.startsWith("''", i)) {
      out += "”";
      i += 2;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/**
 * A line without its `%` comment. A line that starts with `%` is a comment; in a real document
 * (`\documentclass`, `\begin{document}`) so is a `%` after a space. Otherwise `%` is text, so
 * "grew 20% this quarter" keeps its words; `\%` is always a percent sign.
 */
const uncomment = (line: string, real: boolean) => (/^\s*%/.test(line) ? "" : real ? line.replace(/(?<=\s)%.*$/, "") : line);

const MATH_ENVIRONMENTS = new Set(["equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "displaymath", "eqnarray", "eqnarray*", "math"]);
const ALIGNED = new Set(["align", "align*", "eqnarray", "eqnarray*"]);
const DROPPED_WRAPPERS = new Set(["document", "center", "flushleft", "flushright", "minipage", "small", "footnotesize"]);
const CODE_ENVIRONMENTS = new Set(["verbatim", "lstlisting", "minted"]);
const HEADINGS: Record<string, string> = { chapter: "#", section: "#", subsection: "##", subsubsection: "###", paragraph: "###", subparagraph: "###" };

/** TeX for a display equation: without `\label`, an `align` body as `aligned`. */
function displayTex(body: string, environment: string | null): string {
  const tex = body.replace(/\\label\{[^{}]{0,200}\}/g, "").replace(/\\(?:nonumber|notag)\b/g, "").trim();
  return environment && ALIGNED.has(environment) ? `\\begin{aligned}\n${tex}\n\\end{aligned}` : tex;
}

/**
 * The lines of an environment from `first` (the rest of line `from` after its opening) up to
 * `close`, at most 400 lines on; `last` is the line holding `close`. Null when it does not close
 * before another `open`.
 */
function until(lines: readonly string[], from: number, first: string, open: string, close: string, code: boolean, real: boolean): { body: string[]; last: number } | null {
  const body: string[] = [];
  let line = first;
  for (let j = from; ; ) {
    const at = line.indexOf(close);
    if (at >= 0) {
      body.push(line.slice(0, at));
      return { body, last: j };
    }
    body.push(line);
    j += 1;
    if (j >= lines.length || j - from > 400) return null;
    line = code ? lines[j]! : uncomment(lines[j]!, real);
    // Another opening before this one closed: this one never closes.
    if (line.includes(open)) return null;
  }
}

/**
 * A LaTeX document as Markdown for `markdownToNodes` with `lineBreaks` (each `\\` is a line break;
 * source lines of one paragraph are joined).
 */
export function latexToMarkdown(source: string): string {
  let text = source.replace(/\r\n?/g, "\n");
  const real = /\\documentclass\b|\\begin\{document\}/.test(text);
  const out: string[] = [];
  // The preamble goes only when it is all commands and comments; anything else in it is kept as text.
  const begin = text.search(/^[ \t]*\\begin\{document\}/m);
  if (begin > 0) {
    const preamble = text.slice(0, begin);
    if (preamble.split("\n").every((line) => !line.trim() || /^\s*[\\%]/.test(line))) {
      const title = /\\title\{([^{}]{1,500})\}/.exec(preamble)?.[1];
      if (title?.trim()) out.push(`# ${inlineLatex(title.trim())}`, "");
      text = text.slice(begin);
    }
  }
  const lines = text.split("\n");
  let paragraph: string[] = [];
  const lists: Array<"-" | "1."> = [];
  let quote = false;
  const flush = () => {
    const joined = paragraph.map((line) => line.trim()).filter(Boolean).join(" ").trim();
    if (joined) out.push(inlineLatex(joined).split("\n").map((line) => `${quote ? "> " : ""}${line.trim()}`).join("\n"), "");
    paragraph = [];
  };
  const itemPrefix = () => `${"  ".repeat(Math.max(0, lists.length - 1))}${lists.at(-1) ?? "-"} `;
  let item: string[] | null = null;
  const flushItem = () => {
    if (!item) return;
    const joined = inlineLatex(item.map((line) => line.trim()).filter(Boolean).join(" ").trim()).replace(/\s*\n\s*/g, " ");
    out.push(`${itemPrefix()}${joined}`);
    item = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = uncomment(lines[i]!, real);
    const trimmed = line.trim();
    const env = /^\\(begin|end)\{([A-Za-z*]+)\}/.exec(trimmed);
    if (env && env[1] === "begin" && (MATH_ENVIRONMENTS.has(env[2]!) || CODE_ENVIRONMENTS.has(env[2]!))) {
      const name = env[2]!;
      const code = CODE_ENVIRONMENTS.has(name);
      const block = until(lines, i, trimmed.slice(env[0].length), `\\begin{${name}}`, `\\end{${name}}`, code, real);
      if (block) {
        flush();
        flushItem();
        if (code) out.push("```", ...block.body.filter((part, at) => at > 0 || part.trim()).map((part) => part.replace(/\s+$/, "")), "```", "");
        else {
          const tex = displayTex(block.body.join("\n"), name);
          if (tex) out.push("$$", tex, "$$", "");
        }
        i = block.last;
        continue;
      }
    }
    if (trimmed.startsWith("\\[")) {
      const block = until(lines, i, trimmed.slice(2), "\\[", "\\]", false, real);
      if (block) {
        flush();
        flushItem();
        const tex = displayTex(block.body.join("\n"), null);
        if (tex) out.push("$$", tex, "$$", "");
        i = block.last;
        continue;
      }
    }
    if (env && (env[2] === "itemize" || env[2] === "enumerate" || env[2] === "description")) {
      flush();
      flushItem();
      if (env[1] === "begin") lists.push(env[2] === "enumerate" ? "1." : "-");
      else {
        lists.pop();
        if (!lists.length) out.push("");
      }
      continue;
    }
    if (env && (env[2] === "quote" || env[2] === "quotation" || env[2] === "abstract" || DROPPED_WRAPPERS.has(env[2]!))) {
      flush();
      if (env[2] === "quote" || env[2] === "quotation") quote = env[1] === "begin";
      if (env[1] === "begin" && env[2] === "abstract") out.push("**Abstract**", "");
      continue;
    }
    const heading = /^\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?=\{)/.exec(trimmed);
    if (heading) {
      const arg = argument(trimmed, heading[0].length);
      if (arg) {
        flush();
        flushItem();
        out.push(`${HEADINGS[heading[1]!]} ${inlineLatex(arg.value).replace(/\s*\n\s*/g, " ").trim()}`, "");
        const rest = trimmed.slice(arg.end).trim();
        if (rest) paragraph.push(rest);
        continue;
      }
    }
    if (lists.length && /^\\item\b/.test(trimmed)) {
      flushItem();
      const label = /^\\item\s*\[([^\]]{0,200})\]/.exec(trimmed);
      const rest = trimmed.slice(label ? label[0].length : "\\item".length).trim();
      item = [label ? `**${label[1]}** ${rest}` : rest];
      continue;
    }
    if (item) {
      if (trimmed) item.push(trimmed);
      continue;
    }
    if (!trimmed) {
      // Only a blank line ends a paragraph; a line that held only a comment does not.
      if (!lines[i]!.trim()) flush();
      continue;
    }
    paragraph.push(trimmed);
  }
  flush();
  flushItem();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
