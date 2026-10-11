#!/usr/bin/env node
/**
 * Ensemble decision hook: sends a permission prompt or a question from Claude
 * Code, Codex, GitHub Copilot (CLI and VS Code) or Cursor to Ensemble's Needs
 * me page, and answers the tool call with what you chose there — from the
 * app, the web, your phone or `ensemble needs`.
 *
 *   node ensemble-hook.mjs --source cursor|claude|codex|copilot|copilot-cli     (run by the tool, JSON on stdin)
 *   node ensemble-hook.mjs install --target cursor|claude|codex|copilot-cli|vscode --token ens_… [--url http://127.0.0.1:4000] [--project DIR]
 *   node ensemble-hook.mjs uninstall --target … [--project DIR]
 *   node ensemble-hook.mjs --source claude --engine     (a run Ensemble started: ENSEMBLE_ENGINE_URL, ENSEMBLE_RUN)
 *
 * Claude Code's multiple-choice questions (AskUserQuestion) arrive as one
 * Needs me card per question, with the same options, their descriptions, and
 * a typed answer for "Other"; the answers go back as the tool's input, so
 * Claude continues as if you had picked them in its own window.
 *
 * If Ensemble is unreachable, or nobody answers before the wait runs out, the
 * tool falls back to its own prompt. The hook never allows on its own.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readDesktopDiscovery, resolveHookTarget } from "./desktop-discovery.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const CONFIG = join(homedir(), ".ensemble", "hook.json");
const WAIT_SECONDS = Number(process.env.ENSEMBLE_HOOK_WAIT ?? 600);

/** The tool family Ensemble's API knows; the hook's own source also decides the reply format. */
export const API_SOURCE = { cursor: "cursor", claude: "claude", codex: "codex", copilot: "copilot", "copilot-cli": "copilot", other: "other" };

// Tools that only read. The tool does not prompt for these, so neither do we.
const READ_ONLY = new Set([
  "Read", "Glob", "Grep", "LS", "NotebookRead", "WebSearch", "TodoWrite", "TodoRead", "Task", "ExitPlanMode",
  "read_file", "list_dir", "file_search", "grep_search", "semantic_search", "get_errors", "get_changed_files",
  "codebase", "search", "think", "manage_todo_list", "list_code_usages", "test_search", "get_terminal_output",
  "readFile", "listDirectory", "findFiles", "findTextInFiles", "getErrors", "view", "glob", "grep",
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

/** What the tool expects on stdout for an allow, a deny, or "let me ask the person myself" (decision null). */
export function output(source, event, result) {
  const reason = result.reason ?? "";
  if (source === "cursor") {
    const permission = result.decision === "allow" ? "allow" : result.decision === "deny" ? "deny" : "ask";
    return {
      permission,
      ...(permission === "deny" ? { user_message: `Denied in Ensemble${reason ? `: ${reason}` : ""}.`, agent_message: `The user denied this in Ensemble.${reason ? ` Reason: ${reason}` : ""}` } : {}),
      ...(permission === "ask" && result.note ? { user_message: result.note } : {}),
    };
  }
  if (source === "copilot-cli") {
    // Copilot CLI reads the decision at the top level. With no answer, say nothing and it asks itself.
    if (result.decision !== "allow" && result.decision !== "deny") return null;
    return {
      permissionDecision: result.decision,
      permissionDecisionReason: result.decision === "deny" ? `Denied in Ensemble${reason ? `: ${reason}` : ""}.` : "Allowed in Ensemble.",
    };
  }
  if (event === "PermissionRequest") {
    // Claude Code and Codex share this shape.
    if (result.decision === "allow") return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
    if (result.decision === "deny") {
      return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: reason || "Denied in Ensemble." } } };
    }
    return null;
  }
  const permissionDecision = result.decision === "allow" ? "allow" : result.decision === "deny" ? "deny" : "ask";
  // Codex parses "ask" but does not support it yet: say nothing so its own prompt runs.
  if (source === "codex" && permissionDecision === "ask") return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: permissionDecision === "ask" ? result.note ?? "Ensemble did not answer." : `Decided in Ensemble${reason ? `: ${reason}` : ""}`,
    },
  };
}

/** Copilot CLI sends `toolArgs` as a JSON string; everyone else sends `tool_input`. */
export function normalizePayload(payload) {
  if (payload.toolArgs !== undefined && payload.tool_input === undefined) {
    let input = payload.toolArgs;
    if (typeof input === "string") {
      try {
        input = JSON.parse(input);
      } catch {
        input = { value: input };
      }
    }
    return { ...payload, tool_name: payload.tool_name ?? payload.toolName, tool_input: input };
  }
  return payload;
}

/** One Needs me card per AskUserQuestion question: same options, their descriptions, multi-select, and a typed "Other". */
export function questionCards(payload) {
  const input = payload.tool_input ?? {};
  const questions = Array.isArray(input.questions) ? input.questions : [];
  return questions
    .filter((item) => item && typeof item.question === "string")
    .map((item) => {
      const options = Array.isArray(item.options) ? item.options.filter((option) => option && typeof option.label === "string") : [];
      return {
        question: item.question,
        payload: {
          ...payload,
          tool_input: undefined,
          question: item.question,
          header: typeof item.header === "string" ? item.header : null,
          options: options.map((option) => option.label),
          option_details: options.map((option) => ({ label: option.label, description: typeof option.description === "string" ? option.description : "" })),
          multi_select: item.multiSelect === true,
          allow_custom: true,
        },
      };
    });
}

/** The tool input Claude Code continues with: the questions it asked, plus `answers` keyed by question text. */
export function answeredInput(payload, answers) {
  return { ...(payload.tool_input ?? {}), answers };
}

/** The PreToolUse reply for an engine run: Ensemble's verdict, or the answered questions as the tool's new input. */
export function engineOutput(verdict) {
  if (verdict?.decision === "allow") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Allowed by this run's settings in Ensemble.",
        ...(verdict.updatedInput ? { updatedInput: verdict.updatedInput } : {}),
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: verdict?.message || "Not allowed in this run.",
    },
  };
}

/**
 * A run Ensemble started: one request that stays open until the run's rules
 * or the person decide (node:http has no response timeout, unlike fetch). It
 * fails closed: if Ensemble cannot be asked, the call is denied.
 */
async function engineAsk(payload) {
  const base = process.env.ENSEMBLE_ENGINE_URL;
  const run = process.env.ENSEMBLE_RUN;
  if (!base || !run) return { decision: "deny", message: "This hook runs only inside an Ensemble run." };
  const url = new URL("/api/engine/ask", base);
  const body = JSON.stringify({ tool_name: payload.tool_name ?? "", tool_input: payload.tool_input ?? {}, session_id: payload.session_id ?? null });
  return new Promise((done) => {
    const req = httpRequest(
      url,
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-ensemble-run": run } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          try {
            const verdict = JSON.parse(text);
            done(verdict && typeof verdict.decision === "string" ? verdict : { decision: "deny", message: `Ensemble answered ${res.statusCode}: ${verdict?.error ?? "no decision"}.` });
          } catch {
            done({ decision: "deny", message: `Ensemble answered ${res.statusCode} without a decision.` });
          }
        });
      },
    );
    req.on("error", (error) => done({ decision: "deny", message: `Ensemble could not be asked (${error.message}).` }));
    req.end(body);
  });
}

async function readStdin() {
  return new Promise((done) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => done(data));
  });
}

async function ask(source, cliEvent) {
  const raw = await readStdin();
  const payload = normalizePayload(raw.trim() ? JSON.parse(raw) : {});
  const event = cliEvent ?? payload.hook_event_name ?? payload.hookEventName ?? "PreToolUse";
  const tool = payload.tool_name ?? payload.toolName ?? "";
  const print = (value) => {
    if (value) process.stdout.write(JSON.stringify(value));
    process.exit(0);
  };

  if (event === "PreToolUse" && READ_ONLY.has(tool)) print(null);

  const config = { ...readJson(CONFIG, {}), ...(process.env.ENSEMBLE_URL ? { url: process.env.ENSEMBLE_URL } : {}), ...(process.env.ENSEMBLE_TOKEN ? { token: process.env.ENSEMBLE_TOKEN } : {}) };
  const { base, token } = endpoint(config);
  const question = source === "claude" && tool === "AskUserQuestion";
  if (!token) print(question ? null : output(source, event, { decision: null, note: "Ensemble hook is not set up (no token)." }));
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  let id = null;
  const giveUp = async () => {
    if (id) await fetch(`${base}/api/decisions/${id}/cancel`, { method: "POST", headers }).catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", giveUp);
  process.on("SIGINT", giveUp);

  /** Opens one card and waits for it. Returns the row, or null when nobody answered. */
  const waitForAnswer = async (eventName, body) => {
    const created = await fetch(`${base}/api/decisions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ source: API_SOURCE[source] ?? "other", event: eventName, payload: body, waitSeconds: WAIT_SECONDS }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!created.ok) return { refused: created.status };
    const first = await created.json();
    if (first.status === "decided") return first;
    id = first.id;
    const deadline = Date.now() + WAIT_SECONDS * 1000;
    while (Date.now() < deadline) {
      const response = await fetch(`${base}/api/decisions/${id}/wait?timeout=25`, { headers, signal: AbortSignal.timeout(40_000) });
      if (!response.ok) break;
      const row = await response.json();
      if (row.status === "decided") {
        id = null;
        return row;
      }
      if (row.status !== "pending") break;
    }
    await fetch(`${base}/api/decisions/${id}/cancel`, { method: "POST", headers }).catch(() => undefined);
    id = null;
    return null;
  };

  try {
    if (question) {
      // Each question becomes a card; any unanswered one hands the whole set back to Claude's own window.
      const answers = {};
      for (const card of questionCards(payload)) {
        const row = await waitForAnswer("question", card.payload);
        if (!row || row.refused || row.decision !== "allow" || typeof row.reason !== "string" || !row.reason.trim()) print(null);
        answers[card.question] = row.reason.trim();
      }
      if (!Object.keys(answers).length) print(null);
      print({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "Answered in Ensemble.", updatedInput: answeredInput(payload, answers) } });
    }
    const row = await waitForAnswer(event, payload);
    if (row?.refused) print(output(source, event, { decision: null, note: `Ensemble refused the request (${row.refused}).` }));
    if (!row) print(output(source, event, { decision: null, note: "Nobody answered in Ensemble in time." }));
    print(output(source, event, row));
  } catch (error) {
    print(question ? null : output(source, event, { decision: null, note: `Ensemble is not reachable (${error?.message ?? error}).` }));
  }
}

// ── install / uninstall ────────────────────────────────────────────────────

const command = (source) => `"${process.execPath}" "${SCRIPT}" --source ${source}`;
const mine = (entry) => JSON.stringify(entry).includes("ensemble-hook.mjs");

/** Where each tool reads hooks from, per user (or per project with --project). */
export function hookFile(target, options = {}) {
  const home = options.home ?? homedir();
  const project = options.project ? resolve(options.project) : null;
  switch (target) {
    case "cursor":
      return project ? join(project, ".cursor", "hooks.json") : join(home, ".cursor", "hooks.json");
    case "claude":
      return project ? join(project, ".claude", "settings.json") : join(home, ".claude", "settings.json");
    case "codex":
      return project ? join(project, ".codex", "hooks.json") : join(home, ".codex", "hooks.json");
    case "copilot-cli":
      return project ? join(project, ".github", "hooks", "ensemble.json") : join(process.env.COPILOT_HOME || join(home, ".copilot"), "hooks", "ensemble.json");
    case "vscode":
      return join(project ?? resolve(options.cwd ?? process.cwd()), ".github", "hooks", "ensemble.json");
    default:
      throw new Error("--target must be cursor, claude, codex, copilot-cli or vscode");
  }
}

/** The hook file's new content: Ensemble's entries replaced, everything else kept. */
export function withHooks(target, file, remove, hookCommand, wait = WAIT_SECONDS) {
  const timeout = wait + 30;
  if (target === "cursor") {
    const next = { version: 1, hooks: {}, ...file };
    next.version = 1;
    next.hooks = { ...(next.hooks ?? {}) };
    for (const event of ["beforeShellExecution", "beforeMCPExecution"]) {
      const list = (next.hooks[event] ?? []).filter((entry) => !mine(entry));
      if (!remove) list.push({ command: hookCommand("cursor"), timeout });
      next.hooks[event] = list;
    }
    return next;
  }
  if (target === "claude" || target === "codex") {
    const next = { ...file, hooks: { ...(file.hooks ?? {}) } };
    const permission = (next.hooks.PermissionRequest ?? []).filter((entry) => !mine(entry));
    if (!remove) permission.push({ matcher: "", hooks: [{ type: "command", command: hookCommand(target), timeout }] });
    next.hooks.PermissionRequest = permission;
    if (target === "claude") {
      // Claude Code's multiple-choice questions. Codex has no question hook.
      const pre = (next.hooks.PreToolUse ?? []).filter((entry) => !mine(entry));
      if (!remove) pre.push({ matcher: "AskUserQuestion", hooks: [{ type: "command", command: hookCommand("claude"), timeout }] });
      next.hooks.PreToolUse = pre;
    }
    return next;
  }
  if (target === "copilot-cli") {
    const next = { version: 1, ...file, hooks: { ...(file.hooks ?? {}) } };
    const list = (next.hooks.preToolUse ?? []).filter((entry) => !mine(entry));
    if (!remove) list.push({ type: "command", bash: hookCommand("copilot-cli"), powershell: `& ${hookCommand("copilot-cli")}`, timeoutSec: timeout });
    next.hooks.preToolUse = list;
    return next;
  }
  if (target === "vscode") {
    return remove ? { hooks: {} } : { hooks: { PreToolUse: [{ type: "command", command: hookCommand("copilot"), timeout }] } };
  }
  throw new Error("--target must be cursor, claude, codex, copilot-cli or vscode");
}

function install(opts, remove = false) {
  const target = opts.target;
  const path = hookFile(target, { project: opts.project });
  if (!remove) {
    const token = opts.token ?? readJson(CONFIG, {}).token;
    if (!token) throw new Error("--token ens_… is required the first time (create one in Ensemble → Settings → Editors & agents).");
    if (!String(token).startsWith("ens_")) {
      throw new Error("That token is not a Ensemble token. In Settings → Editors & agents, press Create token, and paste the ens_… value. A Cursor or provider API key will not sign this hook in.");
    }
    const current = readJson(CONFIG, {});
    writeJson(CONFIG, { url: opts.url ?? current.url ?? "http://127.0.0.1:4000", token: opts.token ?? current.token }, 0o600);
  }
  if (target === "vscode" && remove && !existsSync(path)) {
    console.log(`Nothing to remove at ${path}.`);
    return;
  }
  writeJson(path, withHooks(target, readJson(path, {}), remove, command));
  console.log(`${remove ? "Removed Ensemble from" : "Ensemble hook installed in"}:\n  ${path}`);
  if (!remove) {
    console.log(`Config: ${CONFIG}`);
    console.log(
      target === "codex"
        ? "Open Codex and approve the Ensemble hook once in /hooks (Codex asks before running any new hook)."
        : "Restart the tool (or reload hooks) so it picks this up.",
    );
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const opts = args();
  const verb = opts._[0];
  if (verb === "install" || verb === "uninstall") {
    try {
      install(opts, verb === "uninstall");
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  } else if (opts.engine) {
    const raw = await readStdin();
    const payload = normalizePayload(raw.trim() ? JSON.parse(raw) : {});
    process.stdout.write(JSON.stringify(engineOutput(await engineAsk(payload))));
    process.exit(0);
  } else {
    await ask(opts.source ?? "other", opts.event);
  }
}
