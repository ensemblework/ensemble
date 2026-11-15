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
  return documents.map(({ file, markdown, references }) => {
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
    if (references) for (const token of tokens) {
      if (!token.children) continue;
      let linkDepth = 0;
      const children = [];
      for (const child of token.children) {
        if (child.type === "link_open") linkDepth++;
        if (child.type === "link_close") linkDepth--;
        if (child.type !== "text" || linkDepth) { children.push(child); continue; }
        const make = (type, tag, nesting, content = "") => {
          const item = new child.constructor(type, tag, nesting);
          item.content = content;
          return item;
        };
        let start = 0;
        for (const match of child.content.matchAll(/§(\d+(?:\.\d+)*[a-z]?)(?![\w.])/gi)) {
          const target = references[match[1]];
          if (!target) continue;
          children.push(make("text", "", 0, child.content.slice(start, match.index)));
          const open = make("link_open", "a", 1);
          open.attrSet("href", target.path);
          children.push(open, make("text", "", 0, target.title), make("link_close", "a", -1));
          start = match.index + match[0].length;
        }
        children.push(make("text", "", 0, child.content.slice(start)));
      }
      token.children = children;
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

const iconPaths = {
  new: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  history: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5m4-1v5l3 2"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  clear: '<path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6"/>',
  logout: '<path d="M9 21H4V3h5m6 5 4 4-4 4m-7-4h11"/>',
  send: '<path d="m6 12 6-6 6 6m-6-6v14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20.8 13A9 9 0 0 1 11 3.2 9 9 0 1 0 20.8 13Z"/>',
};
const uiIcon = (name) => `<svg width="${({ history: 15, clear: 15, expand: 14, close: 15, logout: 15, send: 14 })[name] ?? 16}" height="${({ history: 15, clear: 15, expand: 14, close: 15, logout: 15, send: 14 })[name] ?? 16}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name]}</svg>`;

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
<link rel="stylesheet" href="/assistant.css">
<link rel="stylesheet" href="/site.css">
<script type="module" src="/helper.js"></script>
<script type="module" src="/site.js"></script>
</head>
<body>
<a class="skip-link" href="#content">Skip to content</a>
<header class="site-header"><a class="brand" href="/">${staticSVG(32, { id: "docs-header", tone: "auto" })}Ensemble <span>Docs</span></a><button id="search-trigger" type="button" aria-label="Search docs" aria-haspopup="dialog">${uiIcon("search")}<span>Search docs</span><kbd>⌘ K</kbd></button><nav aria-label="Ensemble"><a href="https://app.ensemblework.com">Open Ensemble</a><a id="docs-login" href="https://app.ensemblework.com/login?next=https%3A%2F%2Fdocs.ensemblework.com%2F%23docs-chat">Sign in</a><button id="theme-toggle" class="icon-btn" type="button" aria-label="Switch to light theme" title="Switch to light theme" hidden><span data-theme-icon="sun">${uiIcon("sun")}</span><span data-theme-icon="moon" hidden>${uiIcon("moon")}</span></button></nav></header>
<div class="layout">
<aside class="sidebar"><details open><summary>All guides</summary><nav aria-label="Documentation">${navigation}</nav></details></aside>
<main id="content" tabindex="-1">
${parent ? `<a class="guide-back" href="${e(parent.path)}">${e(parent.title)} topics</a>` : ""}
<article>${page.html}</article>
${(page.aliases ?? []).map((alias) => `<div id="${e(alias.id)}" class="legacy-topic"><a href="${e(pagePath(alias.file))}">Continue to ${e(alias.title)}</a></div>`).join("\n")}
<footer class="page-source"><span>Ensemble documentation</span><a href="/">All guides</a></footer>
</main>
<aside class="on-page"><nav aria-label="On this page"><strong>${siblings.length ? "In this guide" : "On this page"}</strong>${siblings.length ? topicNavigation : toc}</nav></aside>
</div>
<dialog id="docs-search" aria-label="Search documentation"><form id="search-form" role="search"><label for="query">Search docs</label><div class="search-field">${uiIcon("search")}<input id="query" name="q" type="search" maxlength="200" placeholder="Search the documentation…" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="search-results" aria-autocomplete="list"><button id="search-close" type="button" aria-label="Close search">${uiIcon("close")}</button></div></form><p id="search-status" role="status"></p><div id="search-results" role="listbox" aria-label="Search results"></div><footer><span>↑ ↓ Navigate</span><span>Enter Open</span><span>Esc Close</span></footer></dialog>
<button id="docs-launcher" class="ask-launcher" type="button" aria-label="Ask the docs" aria-expanded="false" aria-controls="docs-helper" hidden><span class="u-morph">${staticSVG(32, { id: "docs-launcher-mark", tone: "auto" })}</span></button>
<section id="docs-helper" class="assistant-window pop-in" role="dialog" aria-labelledby="helper-title" data-endpoint="${e(endpoint)}" hidden>
${["left", "top", "corner"].map((edge) => `<div class="assistant-resize" data-edge="${edge}" ${edge === "corner" ? 'aria-hidden="true"' : `role="separator" tabindex="0" aria-label="Resize the assistant's ${edge === "left" ? "width" : "height"}" aria-orientation="${edge === "left" ? "vertical" : "horizontal"}"`} title="Drag to resize. Double-click to reset."></div>`).join("")}
<header class="assistant-window-header helper-header">
${staticSVG(24, { id: "docs-panel-mark", tone: "auto" })}
<div class="helper-heading"><h2 id="helper-title">Ensemble docs</h2><span class="assistant-header-hint">Your guide to Ensemble</span></div>
<button id="helper-new" class="icon-btn" type="button" aria-label="New chat" title="New chat">${uiIcon("new")}</button>
<button id="helper-history" class="icon-btn" type="button" aria-label="Chat history" title="Chat history" aria-expanded="false" aria-controls="helper-history-panel">${uiIcon("history")}</button>
<button id="helper-clear" class="icon-btn" type="button" aria-label="Clear all docs history" title="Clear all docs history">${uiIcon("clear")}</button>
<button id="helper-expand" class="icon-btn assistant-expand" type="button" aria-label="Expand" title="Expand">${uiIcon("expand")}</button>
<button id="helper-close" class="icon-btn" type="button" aria-label="Close docs helper" title="Close docs helper">${uiIcon("close")}</button>
</header>
<div class="helper-account-row"><span id="helper-account">Guest chat. History is not saved.</span><a id="helper-login" href="https://app.ensemblework.com/login?next=https%3A%2F%2Fdocs.ensemblework.com%2F%23docs-chat">Sign in to save history</a><button id="helper-logout" class="icon-btn" type="button" aria-label="Sign out of Ensemble" title="Sign out of Ensemble" hidden>${uiIcon("logout")}</button></div>
<div id="helper-clear-confirm" hidden><span>Clear all saved docs chats?</span><button id="helper-keep" type="button">Cancel</button><button id="helper-delete" type="button">Clear history</button></div>
<section id="helper-history-panel" aria-label="Chat history" hidden><header><h3>Chat history</h3><button id="helper-history-close" class="icon-btn" aria-label="Back to chat" type="button">${uiIcon("close")}</button></header><div id="helper-chat-list"></div><button id="helper-more-chats" type="button" hidden>Load more chats</button></section>
<div id="helper-conversation" class="assistant-conversation">
<button id="helper-earlier" type="button" hidden>Load earlier messages</button>
<div id="helper-welcome" class="assistant-welcome"><div class="assistant-welcome-head"><div class="assistant-welcome-mark">${staticSVG(38, { id: "docs-welcome-mark", tone: "auto" })}</div><div><h3 class="assistant-welcome-title display">How can I help?</h3><p class="assistant-welcome-sub">Ask about using Ensemble. Answers link to the docs.</p></div></div><div class="assistant-starters"><button class="assistant-starter" type="button" data-docs-question="How do I connect an app?">Connect an app</button><button class="assistant-starter" type="button" data-docs-question="How do I share a page?">Share a page</button><button class="assistant-starter" type="button" data-docs-question="How do I run a task on my computer?">Run a task</button></div></div>
<div id="helper-turns"></div>
<div id="helper-waiting" role="status" hidden><span class="u-morph" data-loader aria-hidden="true"></span><span>Looking in the docs…</span><span id="helper-elapsed" aria-hidden="true"></span></div>
</div>
<div class="assistant-composer-area">
<p id="helper-notice" role="alert" hidden></p><div id="helper-auth-recovery" hidden><button id="helper-retry-session" type="button">Retry sign-in check</button><button id="helper-guest" type="button">Continue as guest</button></div>
<form id="helper-form" class="assistant-composer"><label class="sr-only" for="helper-question">Your question</label><textarea id="helper-question" name="question" maxlength="500" rows="1" placeholder="Ask about Ensemble…"></textarea><button id="helper-submit" class="assistant-send" type="submit" aria-label="Send question" disabled>${uiIcon("send")}<svg class="helper-stop" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/></svg></button></form>
</div>
<p class="helper-disclaimer">AI can make mistakes, please verify</p>
</section>
</body>
</html>
`;
}
