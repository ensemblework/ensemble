import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "jsonc-parser";
import { EDITORS, editorConfigPath, removeCodexToml, setupEditor, upsertCodexToml, type EditorName } from "./editors.js";
import type { LauncherCommand } from "./launcher.js";

const launcher: LauncherCommand = { command: "/usr/local/bin/ensemble", argsPrefix: [], source: "argv" };

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ensemble-cli-test-"));
}

async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

test("JSONC editor writer preserves comments, other servers, and one backup", async () => {
  const home = await tempHome();
  const path = editorConfigPath("cursor", { platform: "linux", home, env: {} })!;
  await ensureParent(path);
  await writeFile(path, `{\n  // keep this comment\n  "mcpServers": {\n    "other": { "command": "other" }\n  }\n}\n`);
  await setupEditor("cursor", { hosted: false, apiBase: "https://api.example.test", token: "ens_test", launcher }, { platform: "linux", home, env: {} });
  const edited = await readFile(path, "utf8");
  assert.match(edited, /keep this comment/);
  const parsed = parse(edited) as { mcpServers: Record<string, { command: string; args?: string[] }> };
  assert.equal(parsed.mcpServers.other.command, "other");
  assert.equal(parsed.mcpServers.ensemble.command, "/usr/local/bin/ensemble");
  assert.deepEqual(parsed.mcpServers.ensemble.args, ["mcp"]);
  const backup = await readFile(`${path}.ensemble-backup`, "utf8");
  await setupEditor("cursor", { hosted: false, apiBase: "https://api.example.test", token: "ens_test", launcher }, { platform: "linux", home, env: {} });
  assert.equal(await readFile(`${path}.ensemble-backup`, "utf8"), backup);
});

test("local JSON writers create the expected Ensemble entry", async () => {
  const writable = EDITORS.filter(
    (editor): editor is EditorName =>
      !["claude-code", "codex", "jetbrains", "continue", "visual-studio"].includes(editor),
  );
  for (const editor of writable) {
    const home = await tempHome();
    const path = editorConfigPath(editor, { platform: "linux", home, env: {} });
    assert.ok(path, editor);
    await ensureParent(path);
    const result = await setupEditor(editor, { hosted: false, apiBase: "https://api.example.test", token: "ens_test", launcher }, { platform: "linux", home, env: {} });
    assert.equal(result.changed, editor === "claude-desktop" ? true : true);
    const parsed = parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.match(JSON.stringify(parsed), /ensemble/);
    assert.match(JSON.stringify(parsed), /mcp/);
  }
});

test("hosted writers use URL forms with the key in the user profile file", async () => {
  const home = await tempHome();
  const vscode = editorConfigPath("vscode", { platform: "linux", home, env: {} })!;
  await ensureParent(vscode);
  await setupEditor("vscode", { hosted: true, apiBase: "https://api.example.test", token: "ens_test", launcher }, { platform: "linux", home, env: {} });
  const parsed = parse(await readFile(vscode, "utf8")) as { servers: { ensemble: { type: string; url: string; headers: Record<string, string> } }; inputs: Array<{ id: string }> };
  assert.equal(parsed.servers.ensemble.type, "http");
  assert.equal(parsed.servers.ensemble.url, "https://api.example.test/mcp");
  assert.equal(parsed.servers.ensemble.headers.Authorization, "Bearer ens_test");
  assert.equal("inputs" in parsed, false);
});

test("Codex TOML replaces main table and preserves unrelated tables and subtables", () => {
  const source = `theme = "dark"\n\n[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.ensemble]\ncommand = "old"\nargs = ["old"]\n\n[mcp_servers.ensemble.env]\nFOO = "bar"\n`;
  const edited = upsertCodexToml(source, { hosted: false, apiBase: "https://api.example.test", token: "ens_test", launcher });
  assert.match(edited, /theme = "dark"/);
  assert.match(edited, /\[mcp_servers\.other\]/);
  assert.match(edited, /command = "\/usr\/local\/bin\/ensemble"/);
  assert.match(edited, /\[mcp_servers\.ensemble\.env\]\nFOO = "bar"/);
  assert.doesNotMatch(edited, /command = "old"/);
  assert.doesNotMatch(removeCodexToml(edited), /\[mcp_servers\.ensemble/);
});

test("writer creates backup only when an original file exists", async () => {
  const home = await tempHome();
  const path = editorConfigPath("gemini", { platform: "linux", home, env: {} })!;
  await setupEditor("gemini", { hosted: false, apiBase: "https://api.example.test", token: "ens_test", launcher }, { platform: "linux", home, env: {} });
  await assert.rejects(() => stat(`${path}.ensemble-backup`));
});

test("Codex TOML edits keep array tables, commented headers and spaced headers intact", async () => {
  const { upsertCodexToml, removeCodexToml } = await import("./editors.js");
  const mode = { hosted: false, apiBase: "https://api.example.test", token: null, launcher };
  const source = [
    'model = "o3"',
    "",
    "[ mcp_servers . ensemble ] # old entry",
    'command = "old"',
    "",
    "[mcp_servers.ensemble.env]",
    'X = "1"',
    "",
    "[mcp_servers.github] # my server",
    'command = "gh-mcp"',
    "",
    "[[profiles.list]]",
    'name = "a"',
    "",
  ].join("\n");
  const updated = upsertCodexToml(source, mode);
  assert.equal(updated.match(/^\s*\[\s*mcp_servers\s*\.\s*ensemble\s*\]/gm)?.length, 1);
  assert.match(updated, /command = "\/usr\/local\/bin\/ensemble"\nargs = \["mcp"\]/);
  assert.doesNotMatch(updated, /command = "old"/);
  assert.match(updated, /\[mcp_servers\.ensemble\.env\]\nX = "1"/);
  assert.match(updated, /\[mcp_servers\.github\] # my server\ncommand = "gh-mcp"/);
  assert.match(updated, /\[\[profiles\.list\]\]\nname = "a"/);
  const removed = removeCodexToml(updated);
  assert.doesNotMatch(removed, /ensemble/);
  assert.match(removed, /\[mcp_servers\.github\] # my server\ncommand = "gh-mcp"/);
  assert.match(removed, /\[\[profiles\.list\]\]\nname = "a"/);
  assert.match(removed, /^model = "o3"/);
});
