import brandIcons from "@ensemble/brand/icons";
const { icons } = brandIcons;
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

export function renderDocs(documents, sourceRef = "testing") {
  const paths = new Map(documents.map(({ file }) => [`/docs/${file}`, pagePath(file)]));
  const sitePaths = new Set(paths.values());
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
    const tokens = original;
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
        if (sitePaths.has(path)) continue;
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
  const guideLabels = {
    "README.md": "Documentation home", "00": "Overview", "02": "The Hub", "03": "Context", "04": "Personal skills", "05": "Scheduled work", "06": "Assigned agents", "07": "Access and activity", "11": "Assistant", "16": "Code", "20_PLOTS": "Plots", "20_QUICK": "Quick capture", "21_BLOCK_DIAGRAMS_CHEATSHEET": "Diagram cheat sheet", "21": "Diagrams", "24": "Execution permissions", "25": "Your computers", "26": "CLI", "27": "Imports", "28": "Spaces", "29": "Sharing", "30": "Your own agents", "31": "Connected apps", "32": "Files", "33": "Included AI", "34": "Assistant actions", "35": "Ensemble Node", "38": "Agent attachments", "39": "Agent tools", "40": "Using these docs", "41": "Agent sessions", "DESKTOP.md": "Desktop app", "CONTEXT_BRIDGE.md": "Connect an editor",
  };
  const navigation = pages.filter((entry) => !entry.parent).map((entry) => {
    const label = Object.entries(guideLabels).sort(([a], [b]) => b.length - a.length).find(([prefix]) => entry.file.startsWith(prefix))?.[1] ?? entry.title;
    return `<a href="${e(entry.path)}"${entry.path === page.path || page.sourceFile === entry.file ? ' aria-current="page"' : ""}>${e(label)}</a>`;
  }).join("\n");
  const toc = page.toc.map(({ heading, id }) => `<a href="#${e(id)}">${e(heading.replace(/^\d+[. ·]+/, ""))}</a>`).join("\n");
  const parent = pages.find((entry) => entry.file === page.parent);
  const children = pages.filter((entry) => entry.parent === page.file);
  const siblings = children.length ? children : pages.filter((entry) => parent && entry.parent === parent.file);
  siblings.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const topicNavigation = siblings.map((entry) => `<a href="${e(entry.path)}"${entry.path === page.path ? ' aria-current="page"' : ""}>${e(entry.title)}</a>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(page.title)} | Ensemble Docs</title>
<meta name="description" content="Learn to use Ensemble with focused guides to tasks, pages, files and agents.">
<link rel="canonical" href="${e(new URL(page.path, DOCS_HOME).href)}">
<script src="/theme.js"></script>
${icons.icon.map((icon) => `<link rel="icon" href="${e(icon.url)}" type="${e(icon.type)}" sizes="${e(icon.sizes)}">`).join("\n")}
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
${parent ? `<a class="guide-back" href="${e(parent.path)}">${e(parent.title)} topics</a>` : ""}
<article>${page.html}</article>
${(page.aliases ?? []).map((alias) => `<div id="${e(alias.id)}" class="legacy-topic"><a href="${e(pagePath(alias.file))}">Continue to ${e(alias.title)}</a></div>`).join("\n")}
<footer class="page-source"><span>Ensemble documentation</span><a href="/">All guides</a></footer>
</main>
<aside class="on-page"><nav aria-label="On this page"><strong>${siblings.length ? "In this guide" : "On this page"}</strong>${siblings.length ? topicNavigation : toc}</nav></aside>
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
