import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCS_HOME } from "../src/search.js";
import { escapeHtml, pageHtml, renderDocs } from "../src/render.mjs";

const app = fileURLToPath(new URL("../", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const out = join(app, "out");
const files = execFileSync("git", ["ls-files", "-z", "--", "docs"], { cwd: root, encoding: "utf8" }).split("\0").filter((file) => file.endsWith(".md"));
const sourceRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const documents = [];
for (const file of files) {
  if ((await lstat(join(root, file))).isSymbolicLink()) throw new Error(`A published doc cannot be a symbolic link: ${file}`);
  documents.push({ file: file.slice("docs/".length), markdown: await readFile(join(root, file), "utf8") });
}
if (!documents.some(({ file }) => file === "README.md")) throw new Error("The published docs need docs/README.md.");
const pages = renderDocs(documents, sourceRef);
if (new Set(pages.map(({ path }) => path)).size !== pages.length) throw new Error("Published documentation URLs must be unique.");
pages.sort((a, b) => (a.path === "/" ? -1 : b.path === "/" ? 1 : a.file.localeCompare(b.file)));
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const page of pages) {
  const destination = join(out, page.path, "index.html");
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, pageHtml(page, pages, sourceRef));
}
for (const file of ["site.js", "site.css", "search.js"]) await cp(join(app, "src", file), join(out, file));
await writeFile(join(out, "search-index.json"), JSON.stringify({ version: 1, pages: pages.map(({ title, path, sections }) => ({ title, path, sections })) }));
await writeFile(join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map(({ path }) => `<url><loc>${escapeHtml(new URL(path, DOCS_HOME).href)}</loc></url>`).join("")}</urlset>\n`);
await writeFile(join(out, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${DOCS_HOME}sitemap.xml\n`);
await writeFile(join(out, "llms.txt"), `# Ensemble documentation\n\nPublic product guides and code maps. No sign-in or key is needed to read these pages.\n\n${pages.map(({ title, path }) => `- [${title}](${new URL(path, DOCS_HOME).href})`).join("\n")}\n`);
await writeFile(join(out, "_redirects"), pages.map(({ file, path }) => `/${file} ${path} 301`).join("\n") + "\n");
await writeFile(join(out, "_headers"), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: default-src 'none'; base-uri 'none'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'
/search-index.json
  Cache-Control: public, max-age=60, must-revalidate
`);
await writeFile(join(out, "404.html"), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page not found | Ensemble Docs</title><h1>Page not found</h1><p><a href="/">Open the documentation home</a></p></html>\n');
console.log(`Published ${pages.length} tracked docs to apps/docs/out.`);
