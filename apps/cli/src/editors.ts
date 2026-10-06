import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { applyEdits, modify, parseTree } from "jsonc-parser";
import { backupOnce, fileExists } from "./paths.js";
import { commandWithSubcommand, isExecutableOnPath, type LauncherCommand } from "./launcher.js";
import { confirm } from "./secret.js";
import { envOf, homeOf, pathApi, platformOf, type PlatformInput } from "./platform.js";

export const EDITORS = [
  "vscode",
  "vscode-insiders",
  "cursor",
  "windsurf",
  "claude-desktop",
  "claude-code",
  "codex",
  "gemini",
  "copilot",
  "zed",
  "visual-studio",
  "cline",
  "opencode",
  "jetbrains",
  "continue",
] as const;

export type EditorName = (typeof EDITORS)[number];

export type EditorDetection = {
  editor: EditorName;
  found: boolean;
  path?: string;
  printOnly?: boolean;
};

export type SetupMode = {
  hosted: boolean;
  apiBase: string;
  token: string | null;
  launcher: LauncherCommand;
};

export type EditorWriteResult = {
  editor: EditorName;
  changed: boolean;
  message: string;
  path?: string;
};

function assertEditor(value: string): asserts value is EditorName {
  if (!(EDITORS as readonly string[]).includes(value)) throw new Error(`Unknown editor "${value}". Run \`ensemble mcp editors\` to see supported editors.`);
}

export function parseEditorNames(values: string[]): EditorName[] {
  return values.map((value) => {
    assertEditor(value);
    return value;
  });
}

function vscodeUserDir(kind: "stable" | "insiders", input: PlatformInput = {}): string {
  const platform = platformOf(input);
  const env = envOf(input);
  const home = homeOf(input);
  const path = pathApi(platform);
  const name = kind === "stable" ? "Code" : "Code - Insiders";
  if (platform === "win32") return path.join(env.APPDATA?.trim() || path.join(home, "AppData", "Roaming"), name, "User");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", name, "User");
  return path.join(env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"), name, "User");
}

export function editorConfigPath(editor: EditorName, input: PlatformInput = {}): string | null {
  const platform = platformOf(input);
  const env = envOf(input);
  const home = homeOf(input);
  const path = pathApi(platform);
  switch (editor) {
    case "vscode":
      return path.join(vscodeUserDir("stable", input), "mcp.json");
    case "vscode-insiders":
      return path.join(vscodeUserDir("insiders", input), "mcp.json");
    case "cursor":
      return path.join(home, ".cursor", "mcp.json");
    case "windsurf":
      return path.join(home, ".codeium", "windsurf", "mcp_config.json");
    case "claude-desktop":
      if (platform === "win32") return path.join(env.APPDATA?.trim() || path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
      if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      return path.join(env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"), "Claude", "claude_desktop_config.json");
    case "codex":
      return path.join(home, ".codex", "config.toml");
    case "gemini":
      return path.join(home, ".gemini", "settings.json");
    case "copilot":
      return path.join(home, ".copilot", "mcp-config.json");
    case "zed":
      if (platform === "win32") return path.join(env.APPDATA?.trim() || path.join(home, "AppData", "Roaming"), "Zed", "settings.json");
      return path.join(env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"), "zed", "settings.json");
    case "visual-studio":
      return platform === "win32" ? path.join(home, ".mcp.json") : null;
    case "cline":
      return path.join(vscodeUserDir("stable", input), "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json");
    case "opencode":
      return path.join(env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"), "opencode", "opencode.json");
    case "jetbrains":
      return null;
    case "continue":
      return path.join(home, ".continue", "config.yaml");
    case "claude-code":
      return null;
  }
}

export function detectEditors(input: PlatformInput = {}): EditorDetection[] {
  const env = envOf(input);
  const platform = platformOf(input);
  return EDITORS.map((editor) => {
    if (editor === "claude-code") return { editor, found: Boolean(isExecutableOnPath("claude", env, platform)) };
    if (editor === "jetbrains") return { editor, found: true, printOnly: true };
    if (editor === "continue") {
      const path = editorConfigPath(editor, input);
      return { editor, found: Boolean(path && existsSync(dirname(path))), path: path ?? undefined, printOnly: true };
    }
    const path = editorConfigPath(editor, input);
    if (!path) return { editor, found: false };
    return { editor, found: existsSync(dirname(path)) || existsSync(path), path };
  });
}

function localCommand(mode: SetupMode): { command: string; args: string[] } {
  return commandWithSubcommand(mode.launcher, "mcp");
}

function hostedUrl(mode: SetupMode): string {
  return `${mode.apiBase.replace(/\/+$/, "")}/mcp`;
}

function hostedHeaders(mode: SetupMode, placeholder = false): Record<string, string> {
  if (!mode.token && !placeholder) throw new Error("Run `ensemble login` first, or set ENSEMBLE_TOKEN, before writing hosted MCP editor configs.");
  return { Authorization: `Bearer ${placeholder ? "ENSEMBLE_TOKEN" : mode.token}` };
}

function serverValue(editor: EditorName, mode: SetupMode): unknown {
  const local = localCommand(mode);
  if (!mode.hosted) {
    switch (editor) {
      case "vscode":
      case "vscode-insiders":
      case "visual-studio":
        return { type: "stdio", command: local.command, args: local.args };
      case "copilot":
        return { type: "local", command: local.command, args: local.args, tools: ["*"] };
      case "zed":
        return { source: "custom", command: local.command, args: local.args, env: {} };
      case "opencode":
        return { type: "local", command: [local.command, ...local.args], enabled: true };
      case "cline":
        return { command: local.command, args: local.args, disabled: false };
      default:
        return { command: local.command, args: local.args };
    }
  }
  const url = hostedUrl(mode);
  switch (editor) {
    case "vscode":
    case "vscode-insiders":
      // ${input:…} secrets drop the server from VS Code's Agent Host; the user profile file holds the read-only key.
      return { type: "http", url, headers: hostedHeaders(mode) };
    case "cursor":
      return { url, headers: hostedHeaders(mode) };
    case "windsurf":
      return { serverUrl: url, headers: hostedHeaders(mode) };
    case "gemini":
      return { httpUrl: url, headers: hostedHeaders(mode) };
    case "copilot":
      return { type: "http", url, headers: hostedHeaders(mode), tools: ["*"] };
    case "codex":
      return { url, bearer_token_env_var: "ENSEMBLE_TOKEN" };
    case "zed":
      return { url, headers: hostedHeaders(mode) };
    case "visual-studio":
      return { type: "http", url, headers: hostedHeaders(mode) };
    case "cline":
      return { url, headers: hostedHeaders(mode), disabled: false };
    case "opencode":
      return { type: "remote", url, headers: hostedHeaders(mode), enabled: true };
    case "claude-desktop":
      return null;
    default:
      return { url, headers: hostedHeaders(mode) };
  }
}

function jsonPathFor(editor: EditorName): Array<string | number> | null {
  switch (editor) {
    case "vscode":
    case "vscode-insiders":
    case "visual-studio":
      return ["servers", "ensemble"];
    case "cursor":
    case "windsurf":
    case "claude-desktop":
    case "gemini":
    case "cline":
      return ["mcpServers", "ensemble"];
    case "copilot":
      return ["mcpServers", "ensemble"];
    case "zed":
      return ["context_servers", "ensemble"];
    case "opencode":
      return ["mcp", "ensemble"];
    default:
      return null;
  }
}

async function readJsoncForEdit(path: string): Promise<string> {
  try {
    const text = await readFile(path, "utf8");
    return text.trim() ? text : "{}\n";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}\n";
    throw error;
  }
}

async function editJsonc(path: string, updates: Array<{ path: Array<string | number>; value: unknown }>, backup = true): Promise<void> {
  if (backup) await backupOnce(path);
  await mkdir(dirname(path), { recursive: true });
  let text = await readJsoncForEdit(path);
  if (!parseTree(text)) throw new Error(`${path} is not valid JSON/JSONC.`);
  for (const update of updates) {
    text = applyEdits(
      text,
      modify(text, update.path, update.value, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
      }),
    );
  }
  await writeFile(path, text.endsWith("\n") ? text : `${text}\n`);
}


function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function codexTable(mode: SetupMode): string[] {
  if (mode.hosted) return ["[mcp_servers.ensemble]", `url = ${tomlString(hostedUrl(mode))}`, 'bearer_token_env_var = "ENSEMBLE_TOKEN"'];
  const local = localCommand(mode);
  return ["[mcp_servers.ensemble]", `command = ${tomlString(local.command)}`, `args = [${local.args.map(tomlString).join(", ")}]`];
}

type TomlHeader = { name: string; array: boolean };

/** `[a.b]`, `[[a.b]]`, `[ a . "b" ]`, with or without a trailing comment. */
function tomlHeader(line: string): TomlHeader | null {
  const match = /^\s*(\[\[?)([^\[\]]+)(\]\]?)\s*(?:#.*)?$/.exec(line);
  if (!match || match[1]!.length !== match[3]!.length) return null;
  const name = match[2]!
    .split(".")
    .map((part) => part.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"))
    .join(".");
  return { name, array: match[1] === "[[" };
}

const ENSEMBLE_TABLE = "mcp_servers.ensemble";

function isEnsembleTable(header: TomlHeader | null): boolean {
  return Boolean(header && !header.array && header.name === ENSEMBLE_TABLE);
}

function isEnsembleSubtable(header: TomlHeader | null): boolean {
  return Boolean(header && header.name.startsWith(`${ENSEMBLE_TABLE}.`));
}

/** The line after a section's last line: the next header of any kind, or the end. */
function sectionEnd(lines: string[], start: number): number {
  let end = start + 1;
  while (end < lines.length && !tomlHeader(lines[end]!)) end += 1;
  return end;
}

function tidyToml(lines: string[]): string {
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function upsertCodexToml(source: string, mode: SetupMode): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const table = codexTable(mode);
  const tableIndex = lines.findIndex((line) => isEnsembleTable(tomlHeader(line)));
  if (tableIndex >= 0) {
    // Replace only the table's own keys; its subtables (such as .env) stay.
    lines.splice(tableIndex, sectionEnd(lines, tableIndex) - tableIndex, ...table, "");
  } else {
    const firstSubtable = lines.findIndex((line) => isEnsembleSubtable(tomlHeader(line)));
    const insertAt = firstSubtable >= 0 ? firstSubtable : lines.length - (lines.at(-1) === "" ? 1 : 0);
    const prefix = insertAt > 0 && lines[insertAt - 1] !== "" ? [""] : [];
    lines.splice(insertAt, 0, ...prefix, ...table, "");
  }
  return tidyToml(lines);
}

export function removeCodexToml(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (!lines.some((line) => isEnsembleTable(tomlHeader(line)))) return source.endsWith("\n") ? source : `${source}\n`;
  const kept: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const header = tomlHeader(lines[index]!);
    if (isEnsembleTable(header) || isEnsembleSubtable(header)) {
      index = sectionEnd(lines, index);
      continue;
    }
    kept.push(lines[index]!);
    index += 1;
  }
  return tidyToml(kept);
}

async function editCodex(path: string, mode: SetupMode, backup = true): Promise<void> {
  if (backup) await backupOnce(path);
  await mkdir(dirname(path), { recursive: true });
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(path, upsertCodexToml(text, mode));
}

function snippetFor(editor: EditorName, mode: SetupMode): string {
  if (editor === "jetbrains") {
    const local = localCommand(mode);
    const value = mode.hosted ? { mcpServers: { ensemble: { url: hostedUrl(mode), headers: hostedHeaders(mode, true) } } } : { mcpServers: { ensemble: { command: local.command, args: local.args } } };
    return `JetBrains: Settings -> Tools -> AI Assistant -> Model Context Protocol (MCP) -> Add -> As JSON:\n${JSON.stringify(value, null, 2)}`;
  }
  if (editor === "continue") {
    const local = localCommand(mode);
    if (mode.hosted) return `Continue (~/.continue/config.yaml):\nmcpServers:\n  - name: ensemble\n    url: ${hostedUrl(mode)}\n    headers:\n      Authorization: "Bearer ENSEMBLE_TOKEN"`;
    return `Continue (~/.continue/config.yaml):\nmcpServers:\n  - name: ensemble\n    command: ${JSON.stringify(local.command)}\n    args: ${JSON.stringify(local.args)}`;
  }
  if (editor === "claude-code") {
    const local = localCommand(mode);
    if (mode.hosted) return `claude mcp add --scope user --transport http ensemble ${hostedUrl(mode)} --header "Authorization: Bearer ${mode.token ?? "ENSEMBLE_TOKEN"}"`;
    return `claude mcp add --scope user ensemble -- ${[local.command, ...local.args].join(" ")}`;
  }
  if (editor === "codex") return upsertCodexToml("", mode).trimEnd();
  const path = jsonPathFor(editor);
  if (!path) return "";
  const value = serverValue(editor, mode);
  return JSON.stringify(path[0] === "servers" ? { servers: { ensemble: value } } : path[0] === "context_servers" ? { context_servers: { ensemble: value } } : path[0] === "mcp" ? { mcp: { ensemble: value } } : { mcpServers: { ensemble: value } }, null, 2);
}

async function configureClaudeCode(mode: SetupMode, printOnly: boolean): Promise<EditorWriteResult> {
  const command = isExecutableOnPath("claude");
  const snippet = snippetFor("claude-code", mode);
  if (printOnly || !command) return { editor: "claude-code", changed: false, message: command ? snippet : `Claude Code CLI not found on PATH. Run:\n${snippet}` };
  await run(command, ["mcp", "remove", "--scope", "user", "ensemble"], true);
  if (mode.hosted) {
    if (!mode.token) throw new Error("Run `ensemble login` first before configuring Claude Code hosted MCP.");
    await run(command, ["mcp", "add", "--scope", "user", "--transport", "http", "ensemble", hostedUrl(mode), "--header", `Authorization: Bearer ${mode.token}`], false);
  } else {
    const local = localCommand(mode);
    await run(command, ["mcp", "add", "--scope", "user", "ensemble", "--", local.command, ...local.args], false);
  }
  return { editor: "claude-code", changed: true, message: "Configured Claude Code user MCP server." };
}

async function run(command: string, args: string[], allowFailure: boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", (error) => (allowFailure ? resolve() : reject(error)));
    child.once("exit", (code) => {
      if (code === 0 || allowFailure) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code ?? "without a code"}`));
    });
  });
}

export async function setupEditor(editor: EditorName, mode: SetupMode, input: PlatformInput & { printOnly?: boolean } = {}): Promise<EditorWriteResult> {
  if (editor === "claude-code") return configureClaudeCode(mode, input.printOnly === true);
  if (editor === "jetbrains" || editor === "continue") return { editor, changed: false, message: snippetFor(editor, mode), path: editorConfigPath(editor, input) ?? undefined };
  if (mode.hosted && editor === "claude-desktop") {
    return {
      editor,
      changed: false,
      message: "Claude Desktop does not accept the hosted Ensemble MCP URL directly. Configure local mode so Claude Desktop runs `ensemble mcp`.",
      path: editorConfigPath(editor, input) ?? undefined,
    };
  }
  const path = editorConfigPath(editor, input);
  if (!path) throw new Error(`${editor} is not supported on ${platformOf(input)}.`);
  if (input.printOnly) return { editor, changed: false, message: snippetFor(editor, mode), path };
  if (editor === "codex") {
    await editCodex(path, mode);
    const suffix = mode.hosted ? " Set ENSEMBLE_TOKEN in the environment before starting Codex." : "";
    return { editor, changed: true, message: `Updated ${path}.${suffix}`, path };
  }
  const targetPath = jsonPathFor(editor);
  if (!targetPath) throw new Error(`${editor} has no JSON config writer.`);
  const value = serverValue(editor, mode);
  if (value === null) return { editor, changed: false, message: snippetFor(editor, mode), path };
  const updates = [{ path: targetPath, value }];
  await editJsonc(path, updates);
  return { editor, changed: true, message: `Updated ${path}.`, path };
}

export async function removeEditor(editor: EditorName, input: PlatformInput = {}): Promise<EditorWriteResult> {
  if (editor === "claude-code") {
    const command = isExecutableOnPath("claude", envOf(input), platformOf(input));
    if (!command) return { editor, changed: false, message: "Claude Code CLI not found on PATH." };
    await run(command, ["mcp", "remove", "--scope", "user", "ensemble"], true);
    return { editor, changed: true, message: "Removed Claude Code Ensemble MCP server." };
  }
  if (editor === "jetbrains" || editor === "continue") return { editor, changed: false, message: `${editor} is print-only; remove the Ensemble MCP entry manually.` };
  const path = editorConfigPath(editor, input);
  if (!path || !(await fileExists(path))) return { editor, changed: false, message: `${editor} is not configured.` };
  if (editor === "codex") {
    const text = await readFile(path, "utf8");
    await writeFile(path, removeCodexToml(text));
    return { editor, changed: true, message: `Removed Ensemble from ${path}.` };
  }
  const targetPath = jsonPathFor(editor);
  if (!targetPath) return { editor, changed: false, message: `${editor} has no removable config path.` };
  await editJsonc(path, [{ path: targetPath, value: undefined }]);
  return { editor, changed: true, message: `Removed Ensemble from ${path}.`, path };
}

export async function chooseEditors(input: PlatformInput = {}): Promise<EditorName[]> {
  const detected = detectEditors(input).filter((row) => row.found);
  const selected: EditorName[] = [];
  for (const row of detected) {
    if (await confirm(`Configure ${row.editor}${row.printOnly ? " (print instructions)" : ""}?`)) selected.push(row.editor);
  }
  return selected;
}

export async function configuredEditors(input: PlatformInput = {}): Promise<EditorName[]> {
  const configured: EditorName[] = [];
  for (const editor of EDITORS) {
    if (editor === "claude-code" || editor === "jetbrains" || editor === "continue") continue;
    const path = editorConfigPath(editor, input);
    if (!path) continue;
    let text = "";
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (editor === "codex") {
      if (/\[mcp_servers\.ensemble\]/.test(text)) configured.push(editor);
      continue;
    }
    if (/"ensemble"\s*:/.test(text)) configured.push(editor);
  }
  return configured;
}
