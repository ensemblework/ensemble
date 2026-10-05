#!/usr/bin/env node
/**
 * Ensemble decision hook: sends a permission prompt from Cursor, Claude Code or
 * VS Code Copilot to Ensemble's Needs me page and answers the tool call with
 * what you chose there.
 *
 *   node ensemble-hook.mjs --source cursor|claude|copilot     (run by the editor, JSON on stdin)
 *   node ensemble-hook.mjs install --target cursor|claude|vscode --token ens_… [--url http://127.0.0.1:4000] [--project DIR]
 *   node ensemble-hook.mjs uninstall --target cursor|claude|vscode [--project DIR]
 *
 * If Ensemble is unreachable, or nobody answers before the wait runs out, the
 * editor falls back to its own prompt. The hook never allows on its own.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDesktopDiscovery, resolveHookTarget } from "./desktop-discovery.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const CONFIG = join(homedir(), ".ensemble", "hook.json");
const WAIT_SECONDS = Number(process.env.ENSEMBLE_HOOK_WAIT ?? 600);

// Tools that only read. The editor does not prompt for these, so neither do we.
const READ_ONLY = new Set([
  "Read", "Glob", "Grep", "LS", "NotebookRead", "WebSearch", "TodoWrite", "TodoRead", "Task", "ExitPlanMode",
  "read_file", "list_dir", "file_search", "grep_search", "semantic_search", "get_errors", "get_changed_files",
  "codebase", "search", "think", "manage_todo_list", "list_code_usages", "test_search", "get_terminal_output",
  "readFile", "listDirectory", "findFiles", "findTextInFiles", "getErrors",
]);

function args() {
  const out = { _: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") ? true : argv[++i] ?? true;
    else out._.push(argv[i]);
  }
  return out;
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function endpoint(config) {
  return resolveHookTarget({
    configUrl: config.url,
    configToken: config.token,
    discovery: readDesktopDiscovery(process.env),
  });
}

function writeJson(path, value, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  if (mode) chmodSync(path, mode);
}

// ── answering a tool call ──────────────────────────────────────────────────

function output(source, event, result) {
  const reason = result.reason ?? "";
  if (source === "cursor") {
    const permission = result.decision === "allow" ? "allow" : result.decision === "deny" ? "deny" : "ask";
    return {
      permission,
      ...(permission === "deny" ? { user_message: `Denied in Ensemble${reason ? `: ${reason}` : "."}`, agent_message: `The user denied this in Ensemble.${reason ? ` Reason: ${reason}` : ""}` } : {}),
      ...(permission === "ask" && result.note ? { user_message: result.note } : {}),
    };
  }
  if (event === "PermissionRequest") {
    if (result.decision === "allow") return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
    if (result.decision === "deny") {
      return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: reason || "Denied in Ensemble." } } };
    }
    return null;
  }
  const permissionDecision = result.decision === "allow" ? "allow" : result.decision === "deny" ? "deny" : "ask";
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: permissionDecision === "ask" ? result.note ?? "Ensemble did not answer." : `Decided in Ensemble${reason ? `: ${reason}` : ""}`,
    },
  };
}

async function ask(source, cliEvent) {
  const raw = await new Promise((done) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => done(data));
  });
  const payload = raw.trim() ? JSON.parse(raw) : {};
  const event = cliEvent ?? payload.hook_event_name ?? payload.hookEventName ?? "PreToolUse";
  const tool = payload.tool_name ?? payload.toolName ?? "";
  const print = (value) => {
    if (value) process.stdout.write(JSON.stringify(value));
    process.exit(0);
  };

  if (event === "PreToolUse" && READ_ONLY.has(tool)) print(null);

  const config = { ...readJson(CONFIG, {}), ...(process.env.ENSEMBLE_URL ? { url: process.env.ENSEMBLE_URL } : {}), ...(process.env.ENSEMBLE_TOKEN ? { token: process.env.ENSEMBLE_TOKEN } : {}) };
  const { base, token } = endpoint(config);
  if (!token) print(output(source, event, { decision: null, note: "Ensemble hook is not set up (no token)." }));
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  let id = null;
  const giveUp = async () => {
    if (id) await fetch(`${base}/api/decisions/${id}/cancel`, { method: "POST", headers }).catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", giveUp);
  process.on("SIGINT", giveUp);

  try {
    const created = await fetch(`${base}/api/decisions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ source, event, payload, waitSeconds: WAIT_SECONDS }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!created.ok) print(output(source, event, { decision: null, note: `Ensemble refused the request (${created.status}).` }));
    const first = await created.json();
    if (first.status === "decided") print(output(source, event, first));
    id = first.id;
    const deadline = Date.now() + WAIT_SECONDS * 1000;
    while (Date.now() < deadline) {
      const response = await fetch(`${base}/api/decisions/${id}/wait?timeout=25`, { headers, signal: AbortSignal.timeout(40_000) });
      if (!response.ok) break;
      const row = await response.json();
      if (row.status === "decided") print(output(source, event, row));
      if (row.status !== "pending") break;
    }
    await fetch(`${base}/api/decisions/${id}/cancel`, { method: "POST", headers }).catch(() => undefined);
    print(output(source, event, { decision: null, note: "Nobody answered in Ensemble in time." }));
  } catch (error) {
    print(output(source, event, { decision: null, note: `Ensemble is not reachable (${error?.message ?? error}).` }));
  }
}

// ── install / uninstall ────────────────────────────────────────────────────

const command = (source) => `"${process.execPath}" "${SCRIPT}" --source ${source}`;
const mine = (entry) => JSON.stringify(entry).includes("ensemble-hook.mjs");

function install(opts, remove = false) {
  const target = opts.target;
  if (!["cursor", "claude", "vscode"].includes(target)) throw new Error("--target must be cursor, claude or vscode");
  if (!remove) {
    const token = opts.token ?? readJson(CONFIG, {}).token;
    if (!token) throw new Error("--token ens_… is required the first time (create one in Ensemble → Settings → Editors & agents).");
    if (!String(token).startsWith("ens_")) {
      throw new Error("That token is not a Ensemble token. In Settings → Editors & agents, press Create token, and paste the ens_… value. A Cursor or provider API key will not sign this hook in.");
    }
    const current = readJson(CONFIG, {});
    writeJson(CONFIG, { url: opts.url ?? current.url ?? "http://127.0.0.1:4000", token: opts.token ?? current.token }, 0o600);
  }
  const written = [];
  if (target === "cursor") {
    const path = opts.project ? join(resolve(opts.project), ".cursor", "hooks.json") : join(homedir(), ".cursor", "hooks.json");
    const file = readJson(path, { version: 1, hooks: {} });
    file.version = 1;
    file.hooks ??= {};
    for (const event of ["beforeShellExecution", "beforeMCPExecution"]) {
      const list = (file.hooks[event] ?? []).filter((entry) => !mine(entry));
      if (!remove) list.push({ command: command("cursor"), timeout: WAIT_SECONDS + 30 });
      file.hooks[event] = list;
    }
    writeJson(path, file);
    written.push(path);
  } else if (target === "claude") {
    const path = opts.project ? join(resolve(opts.project), ".claude", "settings.json") : join(homedir(), ".claude", "settings.json");
    const file = readJson(path, {});
    file.hooks ??= {};
    const list = (file.hooks.PermissionRequest ?? []).filter((entry) => !mine(entry));
    if (!remove) list.push({ matcher: "", hooks: [{ type: "command", command: command("claude"), timeout: WAIT_SECONDS + 30 }] });
    file.hooks.PermissionRequest = list;
    writeJson(path, file);
    written.push(path);
  } else {
    const project = resolve(opts.project ?? process.cwd());
    const path = join(project, ".github", "hooks", "ensemble.json");
    if (remove) {
      if (existsSync(path)) writeJson(path, { hooks: {} });
    } else {
      writeJson(path, { hooks: { PreToolUse: [{ type: "command", command: command("copilot"), timeout: WAIT_SECONDS + 30 }] } });
    }
    written.push(path);
  }
  console.log(`${remove ? "Removed Ensemble from" : "Ensemble hook installed in"}:\n  ${written.join("\n  ")}`);
  if (!remove) console.log(`Config: ${CONFIG}\nRestart the editor (or reload hooks) so it picks this up.`);
}

const opts = args();
const verb = opts._[0];
if (verb === "install" || verb === "uninstall") {
  try {
    install(opts, verb === "uninstall");
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
} else {
  await ask(opts.source ?? "other", opts.event);
}
