import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { assertOpenVsxUrl, DiskThemeCache, loadOpenVsxTheme, searchThemes, ThemeFetchError } from "./openvsx.js";

function vsix(files: Record<string, string>): Uint8Array {
  const input: Record<string, Uint8Array> = {};
  for (const [name, text] of Object.entries(files)) input[`extension/${name}`] = strToU8(text);
  return zipSync(input);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function routeFetch(routes: Array<(url: string) => Response | undefined>) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    for (const route of routes) {
      const response = route(url);
      if (response) return response;
    }
    return new Response("missing", { status: 404 });
  };
  return { fetchImpl, calls };
}

const samplePkg = JSON.stringify({
  name: "sample",
  publisher: "Sample",
  license: "MIT",
  contributes: { themes: [{ label: "Sample Dark", uiTheme: "vs-dark", path: "./themes/sample.json" }] },
});

const sampleTheme = `{
  // overlay
  "include": "./base.json",
  "colors": { "editor.foreground": "#ffffff", },
  "tokenColors": [{ "scope": "keyword", "settings": { "foreground": "#ff79c6" } }]
}`;

const sampleBase = `{ "colors": { "editor.background": "#010203", "editor.foreground": "#111111", } }`;

test("only open-vsx.org over https is allowed", () => {
  assert.equal(assertOpenVsxUrl("https://open-vsx.org/api/sample/theme").hostname, "open-vsx.org");
  for (const url of ["http://open-vsx.org/api/x", "https://evil.example/x", "https://open-vsx.org.evil.example/x", "https://user:pass@open-vsx.org/x", "not a url"]) {
    assert.throws(() => assertOpenVsxUrl(url), ThemeFetchError);
  }
});

test("a redirect off open-vsx.org is refused before it is fetched", async () => {
  const { fetchImpl, calls } = routeFetch([
    (url) => (url.endsWith("/1.0.0") ? new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }) : undefined),
  ]);
  await assert.rejects(
    () => loadOpenVsxTheme({ namespace: "sample", name: "theme", version: "1.0.0", label: "Sample Dark" }, { fetchImpl }),
    /open-vsx\.org/,
  );
  assert.deepEqual(calls, ["https://open-vsx.org/api/sample/theme/1.0.0"]);
});

test("downloads larger than the limit are refused", async () => {
  const { fetchImpl } = routeFetch([
    (url) => (url.endsWith("/1.0.0") ? jsonResponse({ files: { download: "https://open-vsx.org/api/sample/theme/1.0.0/file/sample.theme-1.0.0.vsix" } }) : undefined),
    (url) => (url.endsWith(".vsix") ? new Response(new Uint8Array(50), { status: 200, headers: { "content-length": "999999" } }) : undefined),
  ]);
  await assert.rejects(
    () => loadOpenVsxTheme({ namespace: "sample", name: "theme", version: "1.0.0", label: "Sample Dark" }, { fetchImpl, maxVsixBytes: 1000 }),
    /larger than Ensemble allows/,
  );
});

test("a bad package, an icon theme, and a code-generated theme are refused cleanly", async () => {
  const bad = routeFetch([
    (url) => (url.endsWith("/1.0.0") ? jsonResponse({ files: { download: "https://open-vsx.org/api/sample/theme/1.0.0/file/sample.theme-1.0.0.vsix" } }) : undefined),
    (url) => (url.endsWith(".vsix") ? new Response(Uint8Array.from([1, 2, 3, 4])) : undefined),
  ]);
  await assert.rejects(
    () => loadOpenVsxTheme({ namespace: "sample", name: "theme", version: "1.0.0", label: "Sample Dark" }, { fetchImpl: bad.fetchImpl }),
    /valid theme package/,
  );

  const iconPkg = JSON.stringify({ contributes: { iconThemes: [{ id: "icons", label: "Icons", path: "./icons.json" }] } });
  const icon = await loadPackaged(iconPkg, { "package.json": iconPkg, "icons.json": "{}" }, "Icons");
  assert.equal(icon.theme, null);
  assert.match(icon.reason ?? "", /icon/i);

  const codePkg = JSON.stringify({
    publisher: "Gen",
    contributes: { themes: [{ label: "Generated", uiTheme: "vs-dark", path: "./theme.js" }] },
  });
  const generated = await loadPackaged(codePkg, { "package.json": codePkg, "theme.js": "module.exports = {}" }, "Generated");
  assert.equal(generated.theme, null);
  assert.match(generated.reason ?? "", /created by the extension/i);
});

test("a JSONC theme with an include chain is converted and then served from disk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-themes-"));
  try {
    const cache = new DiskThemeCache(dir);
    const zip = vsix({
      "package.json": samplePkg,
      "themes/sample.json": sampleTheme,
      "themes/base.json": sampleBase,
    });
    let fetches = 0;
    const { fetchImpl } = routeFetch([
      (url) => {
        fetches += 1;
        if (url.endsWith("/1.2.3")) return jsonResponse({ files: { download: "https://open-vsx.org/api/sample/theme/1.2.3/file/sample.theme-1.2.3.vsix" } });
        if (url.endsWith(".vsix")) return new Response(zip);
        return undefined;
      },
    ]);
    const query = { namespace: "sample", name: "theme", version: "1.2.3", label: "Sample Dark" };
    const first = await loadOpenVsxTheme(query, { fetchImpl, cache });
    const second = await loadOpenVsxTheme(query, { fetchImpl, cache });
    assert.equal(first.theme?.editor?.background, "#010203");
    assert.equal(first.theme?.editor?.foreground, "#ffffff");
    assert.equal(first.theme?.tokens.find((token) => token.role === "keyword")?.color, "#ff79c6");
    assert.equal(second.theme?.id, first.theme?.id);
    assert.equal(fetches, 2);
    await assert.rejects(() => cache.get("../etc/passwd"), ThemeFetchError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("search reads manifests and does not download the package", async () => {
  const { fetchImpl, calls } = routeFetch([
    (url) =>
      url.includes("/-/search?")
        ? jsonResponse({
            extensions: [
              { namespace: "sample", name: "theme", version: "1.0.0", displayName: "Sample", description: "A theme", downloadCount: 1200 },
              { namespace: "evil", name: "../x", version: "1", displayName: "Skip" },
            ],
          })
        : undefined,
    (url) => (url.endsWith("/file/package.json") ? new Response(samplePkg) : undefined),
  ]);
  const result = await searchThemes("sample", { fetchImpl });
  assert.equal(result.extensions.length, 1);
  assert.equal(result.extensions[0]?.themes[0]?.label, "Sample Dark");
  assert.equal(result.extensions[0]?.themes[0]?.kind, "dark");
  assert.equal(calls.some((url) => url.endsWith(".vsix")), false);
  assert.equal(calls.some((url) => url.includes("evil")), false);
});

async function loadPackaged(pkg: string, files: Record<string, string>, label: string) {
  const zip = vsix(files);
  const { fetchImpl } = routeFetch([
    (url) => (url.endsWith("/1.0.0") ? jsonResponse({ files: { download: "https://open-vsx.org/api/sample/theme/1.0.0/file/sample.theme-1.0.0.vsix" } }) : undefined),
    (url) => (url.endsWith(".vsix") ? new Response(zip) : undefined),
  ]);
  void pkg;
  return loadOpenVsxTheme({ namespace: "sample", name: "theme", version: "1.0.0", label }, { fetchImpl });
}
