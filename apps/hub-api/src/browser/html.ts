/**
 * A small HTML reader for pages the runtime only reads: the page's HTML as the browser holds it
 * (`page.content()`, or `CleanPage.html()` in a clean browser where no page script may run) becomes a
 * tree, which `extract.ts` turns into Markdown and product data and `shop/` reads with CSS selectors.
 * It follows the HTML rules that matter for reading (void and raw-text elements, implied end tags,
 * character references), not every rule of the standard. Nothing here runs or fetches anything.
 */

export type HtmlText = { type: "text"; text: string; parent: HtmlElement | null };
export type HtmlElement = { type: "element"; tag: string; attrs: Record<string, string>; children: HtmlNode[]; parent: HtmlElement | null };
export type HtmlNode = HtmlElement | HtmlText;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr"]);
/** Elements whose content is text up to their end tag: kept as one text child, never parsed. */
const RAW = new Set(["script", "style", "noscript", "iframe", "noembed", "noframes", "xmp", "plaintext"]);
/** Raw text with character references decoded. */
const RCDATA = new Set(["title", "textarea"]);
/** Start tags that end an open paragraph. */
const CLOSES_P = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "dialog",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const MAX_DEPTH = 400;

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  curren: "¤",
  times: "×",
  divide: "÷",
  deg: "°",
  plusmn: "±",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  sup1: "¹",
  sup2: "²",
  sup3: "³",
  micro: "µ",
  para: "¶",
  sect: "§",
  shy: "\u00ad",
  zwj: "\u200d",
  zwnj: "\u200c",
  lrm: "\u200e",
  rlm: "\u200f",
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
  dagger: "†",
  Dagger: "‡",
  permil: "‰",
  prime: "′",
  Prime: "″",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  harr: "↔",
  check: "✓",
  star: "☆",
  starf: "★",
  minus: "−",
  le: "≤",
  ge: "≥",
  ne: "≠",
  asymp: "≈",
  infin: "∞",
  iexcl: "¡",
  iquest: "¿",
  ordf: "ª",
  ordm: "º",
  acute: "´",
  cedil: "¸",
  uml: "¨",
  macr: "¯",
  not: "¬",
  brvbar: "¦",
  Agrave: "À",
  Aacute: "Á",
  Acirc: "Â",
  Atilde: "Ã",
  Auml: "Ä",
  Aring: "Å",
  AElig: "Æ",
  Ccedil: "Ç",
  Egrave: "È",
  Eacute: "É",
  Ecirc: "Ê",
  Euml: "Ë",
  Igrave: "Ì",
  Iacute: "Í",
  Icirc: "Î",
  Iuml: "Ï",
  Ntilde: "Ñ",
  Ograve: "Ò",
  Oacute: "Ó",
  Ocirc: "Ô",
  Otilde: "Õ",
  Ouml: "Ö",
  Oslash: "Ø",
  Ugrave: "Ù",
  Uacute: "Ú",
  Ucirc: "Û",
  Uuml: "Ü",
  Yacute: "Ý",
  szlig: "ß",
  agrave: "à",
  aacute: "á",
  acirc: "â",
  atilde: "ã",
  auml: "ä",
  aring: "å",
  aelig: "æ",
  ccedil: "ç",
  egrave: "è",
  eacute: "é",
  ecirc: "ê",
  euml: "ë",
  igrave: "ì",
  iacute: "í",
  icirc: "î",
  iuml: "ï",
  ntilde: "ñ",
  ograve: "ò",
  oacute: "ó",
  ocirc: "ô",
  otilde: "õ",
  ouml: "ö",
  oslash: "ø",
  ugrave: "ù",
  uacute: "ú",
  ucirc: "û",
  uuml: "ü",
  yacute: "ý",
  yuml: "ÿ",
};

const CHAR_REF = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));?/g;

/** Text with its character references (`&amp;`, `&#8217;`, `&#x20AC;`) as the characters they name. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(CHAR_REF, (all, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (decimal || hex) {
      const code = decimal ? Number.parseInt(decimal, 10) : Number.parseInt(hex!, 16);
      if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\ufffd";
      return String.fromCodePoint(code);
    }
    const value = NAMED[name!];
    return value === undefined ? all : value;
  });
}

const ATTR = /\s*([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/y;

function element(tag: string, attrs: Record<string, string>, parent: HtmlElement | null): HtmlElement {
  return { type: "element", tag, attrs, children: [], parent };
}

/** The page's HTML as a tree under a `#document` element. Never throws; at most `maxChars` of it are read (8 MB). */
export function parseHtml(html: string, options: { maxChars?: number } = {}): HtmlElement {
  const source = html.length > (options.maxChars ?? 8_000_000) ? html.slice(0, options.maxChars ?? 8_000_000) : html;
  const root = element("#document", {}, null);
  const stack: HtmlElement[] = [root];
  const current = () => stack[stack.length - 1]!;
  const addText = (text: string) => {
    if (!text) return;
    const parent = current();
    const last = parent.children[parent.children.length - 1];
    if (last?.type === "text") last.text += text;
    else parent.children.push({ type: "text", text, parent });
  };
  /** Closes up to and including the nearest open `tag`, unless a `stop` element comes first. */
  const closeTo = (tags: ReadonlySet<string> | string, stop: ReadonlySet<string> = new Set(["#document"])): boolean => {
    const wanted = (tag: string) => (typeof tags === "string" ? tag === tags : tags.has(tag));
    for (let index = stack.length - 1; index > 0; index -= 1) {
      const tag = stack[index]!.tag;
      if (wanted(tag)) {
        stack.length = index;
        return true;
      }
      if (stop.has(tag)) return false;
    }
    return false;
  };
  const SCOPE = new Set(["#document", "table", "td", "th", "button", "template", "object", "marquee", "applet", "caption", "html"]);
  const LIST_SCOPE = new Set(["#document", "ul", "ol", "table", "template"]);
  const TABLE_SCOPE = new Set(["#document", "table", "template"]);

  let i = 0;
  const length = source.length;
  while (i < length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) {
      addText(decodeEntities(source.slice(i)));
      break;
    }
    if (lt > i) addText(decodeEntities(source.slice(i, lt)));
    i = lt;
    const next = source.charCodeAt(i + 1);
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      i = end < 0 ? length : end + 3;
      continue;
    }
    if (next === 33 /* ! */ || next === 63 /* ? */) {
      const end = source.indexOf(">", i + 2);
      i = end < 0 ? length : end + 1;
      continue;
    }
    if (next === 47 /* / */) {
      const match = /^<\/([a-zA-Z][^\s/>]*)[^>]*>/.exec(source.slice(i, i + 300));
      if (!match) {
        // "</" not followed by a tag name: a bogus comment up to the next ">".
        const end = source.indexOf(">", i + 2);
        i = end < 0 ? length : end + 1;
        continue;
      }
      i += match[0].length;
      const tag = match[1]!.toLowerCase();
      if (tag === "br") {
        current().children.push(element("br", {}, current()));
        continue;
      }
      if (tag === "td" || tag === "th") closeTo(tag, new Set(["#document", "tr", "table", "template"]));
      else if (tag === "tr" || tag === "thead" || tag === "tbody" || tag === "tfoot" || tag === "caption") closeTo(tag, TABLE_SCOPE);
      else if (tag === "table" || tag === "template") closeTo(tag);
      else if (tag === "li" || tag === "dd" || tag === "dt") closeTo(tag, LIST_SCOPE);
      else if (HEADINGS.has(tag)) closeTo(HEADINGS, SCOPE);
      else closeTo(tag, SCOPE);
      continue;
    }
    const nameMatch = /^<([a-zA-Z][^\s/>]*)/.exec(source.slice(i, i + 100));
    if (!nameMatch) {
      addText("<");
      i += 1;
      continue;
    }
    const tag = nameMatch[1]!.toLowerCase();
    let at = i + nameMatch[0].length;
    const attrs: Record<string, string> = {};
    for (;;) {
      while (at < length && (source[at] === "/" ? source[at + 1] !== ">" : /\s/.test(source[at]!))) at += 1;
      if (at >= length || source[at] === ">" || source[at] === "/") break;
      ATTR.lastIndex = at;
      const attr = ATTR.exec(source);
      if (!attr || attr[0].length === 0) {
        at += 1;
        continue;
      }
      at = ATTR.lastIndex;
      const name = attr[1]!.toLowerCase();
      if (!(name in attrs)) attrs[name] = decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? "");
    }
    const selfClosing = source[at] === "/";
    const close = source.indexOf(">", at);
    i = close < 0 ? length : close + 1;

    // Implied end tags, as the HTML parser closes them.
    if (CLOSES_P.has(tag)) closeTo("p", SCOPE);
    if (HEADINGS.has(tag) && HEADINGS.has(current().tag)) stack.pop();
    if (tag === "li") closeTo("li", LIST_SCOPE);
    if (tag === "dt" || tag === "dd") closeTo(new Set(["dt", "dd"]), new Set(["#document", "dl", "table", "template"]));
    if (tag === "tr") closeTo("tr", TABLE_SCOPE);
    if (tag === "td" || tag === "th") closeTo(new Set(["td", "th"]), new Set(["#document", "tr", "table", "template"]));
    if (tag === "thead" || tag === "tbody" || tag === "tfoot") closeTo(new Set(["thead", "tbody", "tfoot"]), TABLE_SCOPE);
    if (tag === "option") closeTo("option", new Set(["#document", "select", "datalist", "optgroup"]));
    if (tag === "a") closeTo("a", SCOPE);

    const parent = current();
    const node = element(tag, attrs, parent);
    parent.children.push(node);
    if (VOID.has(tag) || (selfClosing && (parent.tag === "svg" || hasAncestor(parent, "svg") || hasAncestor(parent, "math")))) continue;
    if (RAW.has(tag) || RCDATA.has(tag)) {
      const end = findEndTag(source, tag, i);
      const text = source.slice(i, end.start);
      if (text) node.children.push({ type: "text", text: RCDATA.has(tag) ? decodeEntities(text) : text, parent: node });
      i = end.after;
      continue;
    }
    if (stack.length < MAX_DEPTH) stack.push(node);
  }
  return root;
}

function hasAncestor(node: HtmlElement, tag: string): boolean {
  for (let at: HtmlElement | null = node; at; at = at.parent) if (at.tag === tag) return true;
  return false;
}

function findEndTag(source: string, tag: string, from: number): { start: number; after: number } {
  const lower = `</${tag}`;
  let at = from;
  for (;;) {
    const found = indexOfIgnoreCase(source, lower, at);
    if (found < 0) return { start: source.length, after: source.length };
    const after = source.charCodeAt(found + lower.length);
    // "</scripts" is not the end of a script.
    if (Number.isNaN(after) || after === 62 || after === 47 || after === 32 || after === 9 || after === 10 || after === 13 || after === 12) {
      const close = source.indexOf(">", found);
      return { start: found, after: close < 0 ? source.length : close + 1 };
    }
    at = found + lower.length;
  }
}

function indexOfIgnoreCase(source: string, needle: string, from: number): number {
  let at = from;
  for (;;) {
    const found = source.indexOf("</", at);
    if (found < 0) return -1;
    if (source.slice(found, found + needle.length).toLowerCase() === needle) return found;
    at = found + 2;
  }
}

// ── walking and reading ─────────────────────────────────────────────────────

/** Every element under `root` (not `root` itself), in document order. */
export function descendants(root: HtmlElement): HtmlElement[] {
  const out: HtmlElement[] = [];
  const stack: HtmlNode[] = [...root.children].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type !== "element") continue;
    out.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]!);
  }
  return out;
}

const NO_TEXT = new Set(["script", "style", "noscript", "template", "iframe", "noembed", "noframes", "head", "svg", "math", "select", "datalist"]);

/** An element's text as a reader sees it: no scripts or styles, whitespace collapsed, one line. */
export function textOf(node: HtmlNode | null | undefined): string {
  if (!node) return "";
  if (node.type === "text") return collapse(node.text);
  const parts: string[] = [];
  const stack: HtmlNode[] = [node];
  while (stack.length) {
    const at = stack.pop()!;
    if (at.type === "text") {
      parts.push(at.text);
      continue;
    }
    if (at !== node && NO_TEXT.has(at.tag)) continue;
    if (at.tag === "br" || at.tag === "p" || at.tag === "div" || at.tag === "li") parts.push(" ");
    for (let index = at.children.length - 1; index >= 0; index -= 1) stack.push(at.children[index]!);
  }
  return collapse(parts.join(""));
}

export function collapse(text: string): string {
  return text.replace(/[\s\u00a0\u200b\u200c\u200d\u200e\u200f\ufeff]+/g, " ").trim();
}

export function attr(node: HtmlElement | null | undefined, name: string): string | null {
  if (!node) return null;
  const value = node.attrs[name];
  return value === undefined ? null : value;
}

export function classes(node: HtmlElement): string[] {
  const value = node.attrs.class;
  return value ? value.split(/\s+/).filter(Boolean) : [];
}

/** Whether the page hides an element from people: `hidden`, `aria-hidden`, an inline `display: none` or `visibility: hidden`. */
export function hiddenByMarkup(node: HtmlElement): boolean {
  if ("hidden" in node.attrs) return true;
  if (node.attrs["aria-hidden"] === "true") return true;
  const style = node.attrs.style;
  if (style && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(style)) return true;
  if (node.tag === "input" && node.attrs.type?.toLowerCase() === "hidden") return true;
  return false;
}

// ── CSS selectors ───────────────────────────────────────────────────────────

type AttrTest = { name: string; op: "" | "=" | "~=" | "|=" | "^=" | "$=" | "*="; value: string; insensitive: boolean };
type Compound = { tag: string | null; ids: string[]; classes: string[]; attrs: AttrTest[]; not: Compound[][]; firstChild?: boolean };
type Complex = { parts: Compound[]; combinators: Array<" " | ">" | "+" | "~"> };

const parsedSelectors = new Map<string, Complex[]>();

/** A selector list as the reader supports it: tags, `#id`, `.class`, attribute tests (`[a]`, `=`, `~=`, `|=`, `^=`, `$=`, `*=`, ` i`), `:not(…)`, `:first-child` and the four combinators. */
export function parseSelector(selector: string): Complex[] {
  const cached = parsedSelectors.get(selector);
  if (cached) return cached;
  const list: Complex[] = [];
  let at = 0;
  const text = selector.trim();
  const fail = (why: string): never => {
    throw new Error(`Unsupported selector "${selector}": ${why}`);
  };
  const compound = (): Compound => {
    const out: Compound = { tag: null, ids: [], classes: [], attrs: [], not: [] };
    let any = false;
    for (;;) {
      const char = text[at];
      if (char === undefined) break;
      if (char === "*") {
        at += 1;
        any = true;
        continue;
      }
      if (/[a-zA-Z]/.test(char) && !any && out.tag === null && !out.ids.length && !out.classes.length && !out.attrs.length) {
        const name = /^[a-zA-Z][\w-]*/.exec(text.slice(at))![0];
        out.tag = name.toLowerCase();
        at += name.length;
        any = true;
        continue;
      }
      if (char === "#" || char === ".") {
        const name = /^[\w-]+/.exec(text.slice(at + 1))?.[0] ?? fail(`an empty ${char === "#" ? "id" : "class"}`);
        (char === "#" ? out.ids : out.classes).push(name);
        at += 1 + name.length;
        any = true;
        continue;
      }
      if (char === "[") {
        const match = /^\[\s*([\w:-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*(i|s)?\s*)?\]/.exec(text.slice(at));
        if (!match) fail("a malformed attribute test");
        out.attrs.push({ name: match![1]!.toLowerCase(), op: (match![2] ?? "") as AttrTest["op"], value: match![3] ?? match![4] ?? match![5] ?? "", insensitive: match![6] === "i" });
        at += match![0].length;
        any = true;
        continue;
      }
      if (char === ":") {
        if (text.startsWith(":not(", at)) {
          at += 5;
          const inner: Compound[] = [];
          for (;;) {
            while (text[at] === " ") at += 1;
            inner.push(compound());
            while (text[at] === " ") at += 1;
            if (text[at] === ",") {
              at += 1;
              continue;
            }
            if (text[at] !== ")") fail("an unclosed :not(");
            at += 1;
            break;
          }
          out.not.push(inner);
          any = true;
          continue;
        }
        if (text.startsWith(":first-child", at)) {
          out.firstChild = true;
          at += ":first-child".length;
          any = true;
          continue;
        }
        fail(`the pseudo-class at "${text.slice(at, at + 20)}"`);
      }
      break;
    }
    if (!any) fail(`nothing to match at "${text.slice(at, at + 20)}"`);
    return out;
  };
  while (at < text.length) {
    const complex: Complex = { parts: [], combinators: [] };
    for (;;) {
      while (text[at] === " ") at += 1;
      complex.parts.push(compound());
      let sawSpace = false;
      while (text[at] === " " || text[at] === "\n" || text[at] === "\t") {
        at += 1;
        sawSpace = true;
      }
      const char = text[at];
      if (char === undefined || char === ",") break;
      if (char === ">" || char === "+" || char === "~") {
        complex.combinators.push(char);
        at += 1;
        continue;
      }
      if (sawSpace) {
        complex.combinators.push(" ");
        continue;
      }
      fail(`an unexpected "${char}"`);
    }
    list.push(complex);
    while (text[at] === " ") at += 1;
    if (text[at] === ",") at += 1;
  }
  if (!list.length) fail("it is empty");
  if (parsedSelectors.size > 500) parsedSelectors.clear();
  parsedSelectors.set(selector, list);
  return list;
}

function testAttr(node: HtmlElement, test: AttrTest): boolean {
  const raw = node.attrs[test.name];
  if (raw === undefined) return false;
  if (!test.op) return true;
  const value = test.insensitive ? raw.toLowerCase() : raw;
  const want = test.insensitive ? test.value.toLowerCase() : test.value;
  switch (test.op) {
    case "=":
      return value === want;
    case "~=":
      return value.split(/\s+/).includes(want);
    case "|=":
      return value === want || value.startsWith(`${want}-`);
    case "^=":
      return want !== "" && value.startsWith(want);
    case "$=":
      return want !== "" && value.endsWith(want);
    case "*=":
      return want !== "" && value.includes(want);
  }
}

function elementSiblings(node: HtmlElement): HtmlElement[] {
  return (node.parent?.children ?? []).filter((child): child is HtmlElement => child.type === "element");
}

function matchesCompound(node: HtmlElement, compound: Compound): boolean {
  if (compound.tag && node.tag !== compound.tag) return false;
  if (compound.ids.length && !compound.ids.every((id) => node.attrs.id === id)) return false;
  if (compound.classes.length) {
    const own = classes(node);
    if (!compound.classes.every((name) => own.includes(name))) return false;
  }
  if (!compound.attrs.every((test) => testAttr(node, test))) return false;
  if (compound.not.some((list) => list.some((inner) => matchesCompound(node, inner)))) return false;
  if (compound.firstChild && elementSiblings(node)[0] !== node) return false;
  return true;
}

function matchesComplex(node: HtmlElement, complex: Complex, scope: HtmlElement | null): boolean {
  const last = complex.parts.length - 1;
  if (!matchesCompound(node, complex.parts[last]!)) return false;
  const walk = (at: HtmlElement, index: number): boolean => {
    if (index < 0) return true;
    const combinator = complex.combinators[index]!;
    const part = complex.parts[index]!;
    if (combinator === ">") {
      const parent = at.parent;
      return Boolean(parent && parent.tag !== "#document" && parent !== scope && matchesCompound(parent, part) && walk(parent, index - 1));
    }
    if (combinator === " ") {
      for (let parent = at.parent; parent && parent.tag !== "#document" && parent !== scope; parent = parent.parent) {
        if (matchesCompound(parent, part) && walk(parent, index - 1)) return true;
      }
      return false;
    }
    const siblings = elementSiblings(at);
    const position = siblings.indexOf(at);
    if (combinator === "+") {
      const previous = siblings[position - 1];
      return Boolean(previous && matchesCompound(previous, part) && walk(previous, index - 1));
    }
    for (let back = position - 1; back >= 0; back -= 1) if (matchesCompound(siblings[back]!, part) && walk(siblings[back]!, index - 1)) return true;
    return false;
  };
  return walk(node, last - 1);
}

/** Whether an element matches a selector list. */
export function matches(node: HtmlElement, selector: string): boolean {
  return parseSelector(selector).some((complex) => matchesComplex(node, complex, null));
}

/** Elements under `root` that match, in document order. Ancestors above `root` do not count for combinators. */
export function querySelectorAll(root: HtmlElement, selector: string): HtmlElement[] {
  const list = parseSelector(selector);
  return descendants(root).filter((node) => list.some((complex) => matchesComplex(node, complex, root)));
}

export function querySelector(root: HtmlElement, selector: string): HtmlElement | null {
  const list = parseSelector(selector);
  const stack: HtmlNode[] = [...root.children].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type !== "element") continue;
    if (list.some((complex) => matchesComplex(node, complex, root))) return node;
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]!);
  }
  return null;
}

/** The closest element (itself included) that matches. */
export function closest(node: HtmlElement, selector: string): HtmlElement | null {
  for (let at: HtmlElement | null = node; at && at.tag !== "#document"; at = at.parent) if (matches(at, selector)) return at;
  return null;
}
