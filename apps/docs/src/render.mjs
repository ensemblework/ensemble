import { readers } from "./readers.mjs";
import { staticSVG } from "@ensemble/brand";
import MarkdownIt from "markdown-it";
import { DOCS_HOME } from "./search.js";

export const escapeHtml = (text) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
export const pagePath = (file) => file === "README.md" ? "/" : `/${file.replace(/\.md$/, "").toLowerCase()}/`;

function inlineText(token) {
  return (token.children ?? []).map((child) => {
    if (child.type === "softbreak" || child.type === "hardbreak") return " ";
    if (child.type === "text" || child.type === "code_inline" || child.type === "image") return child.content;
    return "";
  }).join("");
}

export function renderDocs(documents, sourceRef = "testing", { reader = false } = {}) {
  const paths = new Map(documents.map(({ file }) => [`/docs/${file}`, pagePath(file)]));
  return documents.map(({ file, markdown }) => {
    const md = new MarkdownIt({ html: false });
    md.renderer.rules.table_open = () => '<div class="table-scroll" tabindex="0" role="region" aria-label="Reference table"><table>\n';
    md.renderer.rules.table_close = () => '</table></div>\n';
    // Keep literal union operators inside inline code from splitting a reference table.
    let fence = false;
    const readable = markdown.split("\n").map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      return !fence && /^\s*\|/.test(line) ? line.replace(/`([^`]+)`/g, (_match, code) => "`" + code.replace(/(?<!\\)\|/g, "\\|") + "`") : line;
    }).join("\n");
    const original = md.parse(readable, {});
    const guide = reader ? readers[file] : null;
    if (reader && !guide) throw new Error(`Missing public reader guide: ${file}`);
    const tokens = guide && file !== "README.md" ? md.parse(`# ${guide[0]}\n\n${guide[1]}\n\n${guide[2]}\n\n## Reference\n\n`, {}).concat(original.slice(3)) : original;
    // Capture anchors before shortening visible implementation references.
    for (let i = 0; i < tokens.length; i++) if (tokens[i].type === "heading_open") tokens[i].meta = { sourceHeading: inlineText(tokens[i + 1]) };
    const codePaths = new Map();
    if (reader) {
      for (const token of tokens) for (const child of token.children ?? []) {
        if (child.type === "text") child.content = child.content.replace(/\s*—\s*/g, ", ").replace(/ -- /g, " · ");
        if (child.type === "code_inline" && /^(?:apps|packages|scripts|infra|src|components|lib|routes|workspace|assistant|node|jobs|included|runtime|remote|connectors|files|imports|prisma|\.github)\//.test(child.content) && !/\s/.test(child.content)) {
          const path = child.content;
          if (!codePaths.has(path)) codePaths.set(path, codePaths.size + 1);
          child.meta = { codePath: codePaths.get(path) };
          child.content = path.replace(/\/$/, "").split("/").pop();
        }
      }
      const inlineCode = md.renderer.rules.code_inline;
      md.renderer.rules.code_inline = (items, i, options, env, renderer) => {
        const rendered = inlineCode(items, i, options, env, renderer);
        return items[i].meta?.codePath ? `<a class="code-ref" href="#code-path-${items[i].meta.codePath}">${rendered}</a>` : rendered;
      };
      if (codePaths.size) {
        tokens.push(...md.parse("\n## In the code\n\nImplementation references used in this guide. Paths are relative to the repository or the source folder named in the reference.\n\n" + [...codePaths].map(([path]) => `- \`${path}\``).join("\n"), {}));
        let n = 0;
        for (let i = tokens.length - 1; i >= 0 && n < codePaths.size; i--) {
          if (tokens[i].type === "list_item_open") tokens[i].attrSet("id", `code-path-${codePaths.size - n++}`);
        }
      }
    }
    const counts = new Map();
    const sections = [];
    const toc = [];
    let title = file.replace(/\.md$/, "");
    let section = { heading: title, url: new URL(pagePath(file), DOCS_HOME).href, parts: [] };
    sections.push(section);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === "heading_open") {
        const heading = inlineText(tokens[i + 1]);
        const slug = (token.meta?.sourceHeading ?? heading).toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-") || "section";
        const count = counts.get(slug) ?? 0;
        counts.set(slug, count + 1);
        const id = `${slug}${count ? `-${count}` : ""}`;
        token.attrSet("id", id);
        if (token.tag === "h1" && title === file.replace(/\.md$/, "")) title = heading;
        if (token.tag === "h2" || token.tag === "h3") toc.push({ heading, id });
        section = { heading, url: `${new URL(pagePath(file), DOCS_HOME).href}#${id}`, parts: [] };
        sections.push(section);
      } else if (token.type === "inline") {
        section.parts.push(inlineText(token));
      } else if (token.type === "fence" || token.type === "code_block") {
        section.parts.push(token.content);
      }
      for (const child of token.children ?? []) {
        const attr = child.type === "link_open" ? "href" : child.type === "image" ? "src" : null;
        const href = attr && child.attrGet(attr);
        if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) continue;
        const target = new URL(href, `https://repo.invalid/docs/${file}`);
        const path = decodeURIComponent(target.pathname);
        child.attrSet(attr, paths.has(path)
          ? `${paths.get(path)}${target.hash}`
          : `https://github.com/ensemblework/ensemble/${attr === "src" ? "raw" : "blob"}/${sourceRef}${target.pathname}${target.hash}`);
      }
    }
    return {
      title,
      path: pagePath(file),
      file,
      toc,
      html: md.renderer.render(tokens, md.options, {}),
      sections: sections.map(({ heading, url, parts }) => ({ heading, url, text: parts.join(" ").replace(/\s+/g, " ").trim() })).filter(({ text }) => text),
    };
  });
}

export function pageHtml(page, pages, sourceRef, endpoint = "https://api.ensemblework.com/api/docs/ask") {
  const e = escapeHtml;
  const navigation = pages.map((entry) => `<a href="${e(entry.path)}"${entry.path === page.path ? ' aria-current="page"' : ""}>${e(entry.title.replace(/^\d+[. ·]+/, ""))}</a>`).join("\n");
  const toc = page.toc.map(({ heading, id }) => `<a href="#${e(id)}">${e(heading.replace(/^\d+[. ·]+/, ""))}</a>`).join("\n");
  const source = `https://github.com/ensemblework/ensemble/blob/${sourceRef}/docs/${page.file}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(page.title)} | Ensemble Docs</title>
<meta name="description" content="Ensemble product guides and code maps for people and agents.">
<link rel="canonical" href="${e(new URL(page.path, DOCS_HOME).href)}">
<script src="/theme.js"></script>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/figtree.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/hub-tokens.css">
<link rel="stylesheet" href="/brand-motion.css">
<link rel="stylesheet" href="/site.css">
<script type="module" src="/helper.js"></script>
<script type="module" src="/site.js"></script>
</head>
<body>
<a class="skip-link" href="#content">Skip to content</a>
<header class="site-header"><a class="brand" href="/">${staticSVG(32, { id: "docs-header", tone: "auto" })}Ensemble <span>Docs</span></a><nav aria-label="Ensemble"><a href="https://app.ensemblework.com">Open Ensemble</a><button id="theme-toggle" type="button" hidden>Light theme</button></nav></header>
<div class="layout">
<aside class="sidebar"><details open><summary>All guides</summary><nav aria-label="Documentation">${navigation}</nav></details></aside>
<main id="content" tabindex="-1">
<form id="search-form" role="search"><label for="query">Search docs</label><div class="search-field"><input id="query" name="q" type="search" maxlength="200" placeholder="Search tasks, pages, connected apps…" autocomplete="off"><button type="submit">Search</button></div></form>
<section id="search-results" aria-live="polite" aria-label="Search results" hidden></section>
<article>${page.html}</article>
<footer class="page-source"><span>Ensemble documentation</span><a href="${e(source)}">Edit this page</a></footer>
</main>
<aside class="on-page"><nav aria-label="On this page"><strong>On this page</strong>${toc}</nav></aside>
</div>
<button id="docs-launcher" class="ask-launcher" type="button" aria-label="Ask the docs" aria-expanded="false" aria-controls="docs-helper" hidden><span class="u-morph">${staticSVG(32, { id: "docs-launcher-mark", tone: "auto" })}</span></button>
<section id="docs-helper" role="dialog" aria-labelledby="helper-title" data-endpoint="${e(endpoint)}" hidden>
<header class="helper-header"><h2 id="helper-title">Ask the docs</h2><button id="helper-close" type="button" aria-label="Close docs helper"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></header>
<div id="helper-answer" aria-live="polite">Ask a question about Ensemble. Answers include links to the docs.</div>
<form id="helper-form"><label for="helper-question">Your question</label><div class="question-field"><textarea id="helper-question" name="question" maxlength="500" required rows="2" placeholder="How do I connect an app?"></textarea><button type="submit">Ask</button></div></form>
<p class="helper-disclaimer">AI can make mistakes, please verify</p>
</section>
</body>
</html>
`;
}
