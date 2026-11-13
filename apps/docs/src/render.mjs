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

export function renderDocs(documents, sourceRef = "testing") {
  const paths = new Map(documents.map(({ file }) => [`/docs/${file}`, pagePath(file)]));
  return documents.map(({ file, markdown }) => {
    const md = new MarkdownIt({ html: false });
    const tokens = md.parse(markdown, {});
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
        const slug = heading.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-") || "section";
        const count = counts.get(slug) ?? 0;
        counts.set(slug, count + 1);
        const id = `${slug}${count ? `-${count}` : ""}`;
        token.attrSet("id", id);
        if (token.tag === "h1") title = heading;
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

export function pageHtml(page, pages, sourceRef) {
  const e = escapeHtml;
  const navigation = pages.map((entry) => `<a href="${e(entry.path)}"${entry.path === page.path ? ' aria-current="page"' : ""}>${e(entry.title)}</a>`).join("\n");
  const toc = page.toc.map(({ heading, id }) => `<a href="#${e(id)}">${e(heading)}</a>`).join("\n");
  const source = `https://github.com/ensemblework/ensemble/blob/${sourceRef}/docs/${page.file}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(page.title)} | Ensemble Docs</title>
<meta name="description" content="Ensemble product guides and code maps for people and agents.">
<link rel="canonical" href="${e(new URL(page.path, DOCS_HOME).href)}">
<link rel="stylesheet" href="/site.css">
<script type="module" src="/site.js"></script>
</head>
<body>
<a class="skip-link" href="#content">Skip to content</a>
<header class="site-header"><a class="brand" href="/">Ensemble <span>Docs</span></a><nav aria-label="Ensemble"><a href="https://app.ensemblework.com">Open Ensemble</a><a href="https://github.com/ensemblework/ensemble">Repository</a></nav></header>
<div class="layout">
<aside class="sidebar"><details open><summary>All guides</summary><nav aria-label="Documentation">${navigation}</nav></details></aside>
<main id="content" tabindex="-1">
<form id="search-form" role="search"><label for="query">Search docs</label><div class="search-field"><input id="query" name="q" type="search" maxlength="200" placeholder="Words from a guide" autocomplete="off"><button type="submit">Search</button></div></form>
<section id="search-results" aria-live="polite" aria-label="Search results" hidden></section>
<div class="page-source"><span>Product guides and code maps.</span><a href="${e(source)}">View source</a></div>
<article>${page.html}</article>
</main>
<aside class="on-page"><nav aria-label="On this page"><strong>On this page</strong>${toc}</nav></aside>
</div>
</body>
</html>
`;
}
