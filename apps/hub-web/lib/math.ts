/**
 * TeX equations drawn with KaTeX. KaTeX (its script, styles and fonts) loads the first time an
 * equation is drawn, so pages and chats without math never fetch it. Until it has loaded, and
 * when the TeX is not valid, the equation shows its source.
 */
import type { KatexOptions } from "katex";

type Katex = { renderToString: (tex: string, options?: KatexOptions) => string };

let katex: Katex | null = null;
let loading: Promise<Katex> | null = null;

/** Loads KaTeX and its styles once. The styles are a separate chunk; without them (tests) equations still draw. */
export function loadKatex(): Promise<Katex> {
  loading ??= Promise.all([import("katex"), import("./katex-style").catch(() => null)]).then(([mod]) => {
    katex = (mod as { default?: Katex }).default ?? (mod as unknown as Katex);
    return katex;
  });
  return loading;
}

export type MathResult = { html: string } | { error: string };

/**
 * One equation as KaTeX HTML, or why it cannot be drawn. Commands that would load or link
 * anything (`\href`, `\includegraphics`, `\htmlClass`) are refused.
 */
export function mathHtml(engine: Katex, latex: string, display: boolean): MathResult {
  try {
    return { html: engine.renderToString(latex, { displayMode: display, throwOnError: true, strict: "ignore", trust: false, output: "htmlAndMathml", maxSize: 50, maxExpand: 1000 }) };
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/^KaTeX parse error:\s*/i, "") : "Not valid TeX";
    return { error: message };
  }
}

/**
 * Draws `latex` into `target`. `data-math` on the target says what shows: `pending` (the source,
 * while KaTeX loads), `ok`, `error` (the source, with the reason as its title) or `empty`.
 */
export function drawMath(target: HTMLElement, latex: string, display: boolean): void {
  const source = latex.trim();
  target.dataset.source = source;
  target.removeAttribute("title");
  if (!source) {
    target.dataset.math = "empty";
    target.textContent = "Empty equation";
    return;
  }
  const plain = () => (display ? `$$${source}$$` : `$${source}$`);
  if (!katex) {
    target.dataset.math = "pending";
    target.textContent = plain();
    void loadKatex()
      .then(() => {
        // Drawn again since: that call drew it.
        if (target.dataset.source === source && target.dataset.math === "pending") drawMath(target, source, display);
      })
      .catch(() => undefined);
    return;
  }
  const result = mathHtml(katex, source, display);
  if ("html" in result) {
    target.dataset.math = "ok";
    target.innerHTML = result.html;
    return;
  }
  target.dataset.math = "error";
  target.textContent = plain();
  target.title = `Not valid TeX: ${result.error}`;
}
