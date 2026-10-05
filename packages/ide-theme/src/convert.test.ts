import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BUILTINS, loadBuiltinTheme } from "./builtins.js";
import { convertTheme, resolveThemeDocument, sanitizeIdeTheme } from "./convert.js";
import { parseJsonc } from "./jsonc.js";
import { ENSEMBLE_DEFAULT_ID } from "./types.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const themeFile = (name: string) => readFileSync(new URL(`../themes/${name}`, import.meta.url), "utf8");

function files(map: Record<string, string>): (path: string) => string | null {
  return (path) => map[path] ?? null;
}

test("a real VS Code theme with an include chain and JSONC comments converts", () => {
  const resolved = resolveThemeDocument(
    "themes/dark_plus.json",
    files({
      "themes/dark_plus.json": fixture("dark_plus.json"),
      "themes/dark_vs.json": fixture("dark_vs.json"),
    }),
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.document.include, undefined);
  const converted = convertTheme({
    id: "builtin:dark-plus",
    label: "Dark+",
    publisher: "Microsoft",
    uiTheme: "vs-dark",
    document: resolved.document,
  });
  assert.equal(converted.ok, true);
  if (!converted.ok) return;
  assert.equal(converted.theme.kind, "dark");
  assert.equal(converted.theme.editor?.background, "#1e1e1e");
  const fn = converted.theme.tokens.find((token) => token.role === "function");
  assert.equal(fn?.color, "#dcdcaa");
  assert.equal(converted.theme.cssVars.bg, "#1e1e1e");
  assert.ok(sanitizeIdeTheme(converted.theme));
});

test("a real light theme converts to a light editor", () => {
  const resolved = resolveThemeDocument(
    "themes/light_plus.json",
    files({
      "themes/light_plus.json": fixture("light_plus.json"),
      "themes/light_vs.json": fixture("light_vs.json"),
    }),
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const converted = convertTheme({
    id: "builtin:light-plus",
    label: "Light+",
    uiTheme: "vs",
    document: resolved.document,
  });
  assert.equal(converted.ok, true);
  if (!converted.ok) return;
  assert.equal(converted.theme.kind, "light");
  assert.equal(converted.theme.editor?.background, "#ffffff");
  assert.equal(converted.theme.cssVars["bg-rgb"], "255 255 255");
});

test("bundled Dracula keeps its background and function color", () => {
  const converted = convertTheme({
    id: "builtin:dracula",
    label: "Dracula",
    publisher: "dracula-theme",
    uiTheme: "vs-dark",
    document: parseJsonc(themeFile("dracula.json")),
  });
  assert.equal(converted.ok, true);
  if (!converted.ok) return;
  assert.equal(converted.theme.editor?.background, "#282a36");
  assert.equal(converted.theme.tokens.find((token) => token.role === "function")?.color, "#50fa7b");
});

test("every bundled theme converts, including the light one", async () => {
  assert.equal(BUILTINS.length, 12);
  for (const meta of BUILTINS) {
    const theme = await loadBuiltinTheme(meta.id);
    assert.ok(theme, meta.id);
    assert.equal(theme.kind, meta.kind);
    assert.equal(theme.label, meta.label);
    if (meta.id === ENSEMBLE_DEFAULT_ID) {
      assert.equal(theme.editor, null);
      assert.deepEqual(theme.cssVars, {});
      continue;
    }
    assert.ok(theme.editor?.background);
    assert.equal(theme.cssVars.bg, theme.editor?.background);
    assert.ok(sanitizeIdeTheme(theme));
  }
});

test("malformed themes and unsafe values are rejected", () => {
  const broken = resolveThemeDocument("themes/nope.json", () => "{");
  assert.equal(broken.ok, false);

  const escape = resolveThemeDocument(
    "themes/evil.json",
    files({
      "themes/evil.json": `{ "include": "../../secrets.json", "colors": {} }`,
      "secrets.json": `{ "colors": { "editor.background": "#000000" } }`,
    }),
  );
  assert.equal(escape.ok, false);
  if (!escape.ok) assert.match(escape.reason, /outside/i);

  const cycle = resolveThemeDocument(
    "a.json",
    files({
      "a.json": `{ "include": "./b.json" }`,
      "b.json": `{ "include": "./a.json" }`,
    }),
  );
  assert.equal(cycle.ok, false);

  const poisoned = convertTheme({
    id: "x",
    label: "Poison",
    uiTheme: "vs-dark",
    document: {
      colors: {
        "editor.background": "expression(alert(1))",
        "editor.foreground": "#ffffff",
        "sideBar.background": "url(https://evil.example/x)",
      },
      tokenColors: [{ scope: "keyword", settings: { foreground: "#ff00ff; background: url(1)" } }],
    },
  });
  assert.equal(poisoned.ok, true);
  if (!poisoned.ok) return;
  assert.equal(poisoned.theme.editor?.background, "#1e1e1e");
  assert.equal(JSON.stringify(poisoned.theme).includes("expression"), false);
  assert.equal(JSON.stringify(poisoned.theme).includes("url("), false);
  assert.equal(poisoned.theme.tokens.some((token) => token.role === "keyword"), false);

  assert.equal(convertTheme({ id: "x", label: "No", uiTheme: "vs-dark", document: "nope" }).ok, false);
  assert.equal(sanitizeIdeTheme({ ...poisoned.theme, cssVars: { bg: "red; background:url(1)" } }), null);
});
