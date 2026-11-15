import { publicDocuments } from "../src/publication.mjs";
import brandIcons from "@ensemble/brand/icons";
const { icons } = brandIcons;
import { build } from "esbuild";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCS_HOME } from "../src/search.js";
import { escapeHtml, pageHtml, renderDocs } from "../src/render.mjs";

const require = createRequire(import.meta.url);
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
const publication = publicDocuments(documents);
const pages = renderDocs(publication, sourceRef).map((page, i) => ({ ...page, order: i, parent: publication[i].parent, sourceFile: publication[i].sourceFile, guideTitle: publication.find((entry) => entry.file === publication[i].sourceFile)?.title, aliases: publication[i].aliases }));
if (new Set(pages.map(({ path }) => path)).size !== pages.length) throw new Error("Published documentation URLs must be unique.");
pages.sort((a, b) => (a.path === "/" ? -1 : b.path === "/" ? 1 : a.file.localeCompare(b.file)));
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const page of pages) {
  const destination = join(out, page.path, "index.html");
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, pageHtml(page, pages, sourceRef));
}
for (const file of ["site.js", "site.css", "search.js", "theme.js"]) await cp(join(app, "src", file), join(out, file));
await build({ entryPoints: [join(app, "src/helper.js")], outfile: join(out, "helper.js"), bundle: true, format: "esm", minify: true });
await cp(require.resolve("@ensemble/brand/motion.css"), join(out, "brand-motion.css"));
await mkdir(join(out, "brand"));
for (const icon of icons.icon) await cp(join(root, "apps/hub-web/public", icon.url), join(out, icon.url));
const hubCss = await readFile(join(root, "apps/hub-web/app/globals.css"), "utf8");
const assistantStart = hubCss.indexOf(".ask-launcher {");
const assistantEnd = hubCss.indexOf("/* ── Onboarding", assistantStart);
const popStart = hubCss.indexOf("@keyframes pop-in {");
const popEnd = hubCss.indexOf(".note-panel {", popStart);
if (assistantStart < 0 || assistantEnd < 0 || popStart < 0 || popEnd < 0) throw new Error("Hub assistant styles could not be found.");
await writeFile(join(out, "assistant.css"), hubCss.slice(assistantStart, assistantEnd) + hubCss.slice(popStart, popEnd));
const dark = hubCss.match(/:root,\s*\[data-theme="dark"\]\s*\{([\s\S]*?)^\}/m)?.[1];
const light = hubCss.match(/\[data-theme="light"\]\s*\{([\s\S]*?)^\}/m)?.[1];
if (!dark || !light) throw new Error("Hub theme tokens could not be found.");
await writeFile(join(out, "hub-tokens.css"), `:root, [data-theme="dark"] {${dark}}\n[data-theme="light"] {${light}}\n@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {${light}} }`);
await mkdir(join(out, "fonts"));
for (const name of ["figtree", "fraunces", "jetbrains-mono"]) {
  await cp(require.resolve(`@fontsource-variable/${name}/files/${name}-latin-wght-normal.woff2`), join(out, "fonts", `${name}.woff2`));
  await cp(join(dirname(require.resolve(`@fontsource-variable/${name}/package.json`)), "LICENSE"), join(out, "fonts", `${name}-LICENSE.txt`));
}
await writeFile(join(out, "search-index.json"), JSON.stringify({ version: 1, audience: "public", pages: pages.map(({ title, guideTitle, path, sections }) => ({ title: guideTitle && guideTitle !== title ? `${guideTitle} · ${title}` : title, path, sections })) }));
await writeFile(join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map(({ path }) => `<url><loc>${escapeHtml(new URL(path, DOCS_HOME).href)}</loc></url>`).join("")}</urlset>\n`);
await writeFile(join(out, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${DOCS_HOME}sitemap.xml\n`);
await writeFile(join(out, "llms.txt"), `# Ensemble documentation\n\nFocused public product guides. No sign-in or key is needed to read these pages.\n\n${pages.map(({ title, path }) => `- [${title}](${new URL(path, DOCS_HOME).href})`).join("\n")}\n`);
await writeFile(join(out, "_redirects"), pages.filter((page) => !page.parent).map(({ file, path }) => `/${file} ${path} 301`).join("\n") + "\n");
await writeFile(join(out, "_headers"), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: default-src 'none'; base-uri 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' https: data:; connect-src 'self' https://api.ensemblework.com; form-action 'self'; frame-ancestors 'none'
/search-index.json
  Cache-Control: public, max-age=60, must-revalidate
`);
await writeFile(join(out, "404.html"), pageHtml({ title: "Page not found", file: "README.md", path: "/404.html", toc: [], html: '<h1>Page not found</h1><p>Try search, or <a href="/">browse the documentation</a>.</p>' }, pages, sourceRef));
console.log(`Published ${pages.length} focused pages from tracked docs to apps/docs/out.`);
