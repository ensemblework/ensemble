import MarkdownIt from 'markdown-it';
import { pagePath } from './render.mjs';

// These guides describe maintaining Ensemble, not using the public product.
const INTERNAL_GUIDES = new Set(['01_TECH_STACK_AND_ENVIRONMENT.md', '17_REPOSITORY_STRUCTURE.md', '36_WEB_TESTING.md', '37_PAUSED_CHECKS.md', 'BRAND.md', 'CACHING.md', 'DEMO_DATA.md', 'desktop/MAC_CHECKLIST.md', '22_BLOCK_DIAGRAMS_FOR_AGENTS.md']);
const INTERNAL_HEADING = /^(?:\d+[a-z]?[. ·]+)?(?:in the code|source map|code map|api(?: contract)?|routes|tests?(?: and|$)|verification|architecture|pieces|normalized model|storage & performance|how a space is stored|which space a request uses|component ownership|libraries and runtime ownership|how it is built|pipeline|json model|build and hosting|operator settings|data and retention|how a call is metered|what .* says|adding a tool|conventions and logs|how it works$)/i;
// "How it works" is a reader heading in Imports; keep it there explicitly.
const SOURCE_PATH = /(?:^|[\s`(])(?:apps|packages|scripts|infra|src|components|lib|routes|workspace|assistant|jobs|included|runtime|remote|connectors|prisma|\.github)\/[\w.*()[\]/-]+|\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|rs)\b/;
const cleanTitle = (title) => title.replace(/^\d+(?:\.\d+)*[a-z]?(?:[. ·]+\s*|\s+)/, '').replace(/`/g, '').replace(/—/g, ':').trim();
const slug = (title) => title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-') || 'section';
const leafSlug = (title) => slug(cleanTitle(title)).slice(0, 110);
const plain = (text) => text.replace(/`/g, '');

function cleanBody(markdown) {
  let fence = false;
  let skipFence = false;
  const lines = markdown.split('\n');
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      if (!fence) {
        const end = lines.findIndex((next, n) => n > i && /^\s*(```|~~~)/.test(next));
        const block = lines.slice(i, end < 0 ? lines.length : end + 1).join('\n');
        skipFence = SOURCE_PATH.test(block) || /github\.com\/ensemblework\/ensemble\b|\b(?:import|export|function|class)\s|SELECT\s|CREATE TABLE/i.test(block);
      }
      fence = !fence;
      if (!skipFence) result.push(line);
      continue;
    }
    if (fence) { if (!skipFence) result.push(line); continue; }
    if (line.trim().startsWith("|") && [...INTERNAL_GUIDES].some((file) => line.includes(file))) continue;
    if (/^\s*(?:Code:|Source:|Implementation:|The code is|Paths below|The server is `|The implementation is)/i.test(line)) continue;
    // Parenthetical code citations belong to repo docs. Keep parenthetical product facts.
    line = line.replace(/\([^()\n]*\)/g, (value) => SOURCE_PATH.test(value) && !/\b(?:limit|maximum|default|otherwise|only|seconds|minutes|MB|GB|days)\b/i.test(value) ? '' : value);
    line = line.replace(/\b(?:in|from|through|by|using)\s+`([^`]+)`/g, (match, value) => SOURCE_PATH.test(value) ? '' : match);
    line = line.replace(/`([^`]+)`/g, (match, value) => SOURCE_PATH.test(value) || /^(?:private|design)\//.test(value) ? '' : match);
    line = line.replace(/https:\/\/github\.com\/ensemblework\/ensemble(?:\/[^\s)<>]*)?/g, '');
    // GitHub source URLs cannot survive as plain text, even if they were not Markdown links.
    line = line.replace(/\s*—\s*/g, ', ').replace(/ -- /g, ' · ').replace(/\(\s*[,;]?\s*\)/g, '').replace(/\s+([.,;:])/g, '$1').replace(/,\s*,/g, ',').replace(/(?<=\S) {2,}/g, ' ');
    if (SOURCE_PATH.test(line)) continue;
    result.push(line);
  }
  return result.join('\n').trim();
}

/** Turn source guides into focused public topics. Repo implementation maps are never published. */
export function publicDocuments(documents) {
  const md = new MarkdownIt();
  const entries = [];
  const targets = new Map();
  const numbered = new Map();
  for (const document of documents) {
    if (INTERNAL_GUIDES.has(document.file)) continue;
    const lines = document.markdown.split('\n');
    const parsed = md.parse(document.markdown, {});
    const headings = parsed.flatMap((token, i) => token.type === 'heading_open' ? [{ level: Number(token.tag.slice(1)), title: parsed[i + 1].content, line: token.map[0] }] : []);
    const first = headings[0];
    if (!first) continue;
    const cutoff = headings.find((heading) => /^in (?:the )?code$/i.test(plain(heading.title)))?.line ?? lines.length;
    const parent = { file: document.file, sourceFile: document.file, title: cleanTitle(first.title), parent: null, children: [], aliases: [], markdown: '' };
    entries.push(parent);
    targets.set(`/docs/${document.file}`, pagePath(parent.file));
    targets.set(`/docs/${document.file}#${slug(plain(first.title))}`, pagePath(parent.file));
    const used = new Map();
    let skippedLevel = 7;
    const hierarchy = [{ level: 1, entry: parent }];
    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i];
      if (heading.line >= cutoff) break;
      if (heading.level <= skippedLevel) skippedLevel = 7;
      const internal = i > 0 && INTERNAL_HEADING.test(plain(heading.title)) && !(document.file === '27_IMPORTS.md' && /How it works/i.test(heading.title));
      if (internal) skippedLevel = heading.level;
      if (heading.level > skippedLevel || internal) continue;
      const body = cleanBody(lines.slice(heading.line + 1, Math.min(headings[i + 1]?.line ?? cutoff, cutoff)).join('\n'));
      if (i === 0) { parent.markdown = `# ${parent.title}\n\n${body}`; continue; }
      if (!body && (headings[i + 1]?.level ?? 1) <= heading.level) continue;
      while (hierarchy.length > 1 && hierarchy.at(-1).level >= heading.level) hierarchy.pop();
      const owner = hierarchy.at(-1).entry;
      const base = leafSlug(heading.title);
      const count = used.get(base) ?? 0;
      used.set(base, count + 1);
      const file = `${document.file.replace(/\.md$/, '').toLowerCase()}/${base}${count ? `-${count + 1}` : ''}.md`;
      const entry = { file, sourceFile: document.file, parent: owner.file, title: cleanTitle(heading.title), children: [], aliases: [], markdown: `# ${cleanTitle(heading.title)}\n\n${body}` };
      entries.push(entry);
      owner.children.push(entry);
      hierarchy.push({ level: heading.level, entry });
      const number = heading.title.match(/^(\d+(?:\.\d+)*[a-z]?)(?=[. ·\s])/i)?.[1];
      if (number) numbered.set(`${document.file}:${number}`, entry);
      parent.aliases.push({ id: slug(plain(heading.title)), file: entry.file, title: entry.title });
      targets.set(`/docs/${document.file}#${slug(plain(heading.title))}`, pagePath(file));
    }
  }
  const entryByPath = new Map(entries.map((entry) => [pagePath(entry.file), entry]));
  for (const entry of entries) {
    if (entry.children.length) entry.markdown += '\n\n## Topics\n\n' + entry.children.map((child) => `- [${child.title}](${pagePath(child.file)})`).join('\n');
    entry.markdown = entry.markdown.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, href) => {
      if (href.startsWith('/') && !href.startsWith('/docs/')) return match;
      if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
        return /github\.com\/ensemblework\/ensemble(?:\/|$)/i.test(href) ? label : match;
      }
      let target;
      try { target = new URL(href, `https://source.invalid/docs/${entry.sourceFile}`); } catch { return label; }
      const key = decodeURIComponent(target.pathname);
      const destination = targets.get(`${key}${target.hash}`) ?? targets.get(key);
      const readableLabel = /^\d+(?:\s*§[\d.a-z]+(?:[–-]§?[\d.a-z]+)?)?$/i.test(label.trim()) ? entryByPath.get(destination)?.title ?? label : label;
      return destination ? `[${readableLabel}](${destination})` : (SOURCE_PATH.test(label) ? '' : label);
    });
    entry.references = Object.fromEntries([...numbered].filter(([key]) => key.startsWith(`${entry.sourceFile}:`)).map(([key, target]) => [key.slice(entry.sourceFile.length + 1), { title: target.title, path: pagePath(target.file) }]));
  }
  return entries;
}
