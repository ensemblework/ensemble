/** Shared by the desktop E2E tests: a stub model runtime, the sidecar on PGlite, and a git source repository. */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const hub = fileURLToPath(new URL("../..", import.meta.url));
export const TOKEN = "agent-flow-token-0123456789";

type Call = { name: string; args: Record<string, unknown> };
type ChatMessage = { role: string; content?: string | null; tool_calls?: unknown[] };

export interface StubRuntime {
  url: string;
  /** Model requests seen per task title. */
  calls: Map<string, number>;
  /** `[slow]` tasks hang until aborted unless their title is listed here. */
  fast: Set<string>;
  close: () => Promise<void>;
}

function lastToolResult(messages: ChatMessage[]): Record<string, unknown> {
  const tool = [...messages].reverse().find((message) => message.role === "tool");
  try {
    return JSON.parse(String(tool?.content ?? "{}")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** One scripted step per assistant turn so far. */
function script(title: string, turn: number, messages: ChatMessage[], fast: boolean): Call | "hang" | null {
  if (title.startsWith("[edit]")) {
    const steps: Array<() => Call> = [
      () => ({ name: "list_dir", args: {} }),
      () => ({ name: "ask_user", args: { question: "Which greeting?", options: ["world", "there"], allow_custom: false } }),
      () => ({ name: "edit_file", args: { path: "hello.txt", old_text: "hello", new_text: `hello, ${String(lastToolResult(messages).answer ?? "nobody")}` } }),
      () => ({ name: "run_command", args: { command: "cat hello.txt" } }),
      () => ({ name: "finish", args: { summary: "Changed the greeting." } }),
    ];
    return steps[turn]?.() ?? null;
  }
  if (title.startsWith("[outside]")) {
    return turn === 0 ? { name: "run_command", args: { command: "ls /etc" } } : { name: "finish", args: { summary: "Looked." } };
  }
  if (title.startsWith("[slow]")) {
    if (!fast) return "hang";
    return turn === 0 ? { name: "write_file", args: { path: "again.txt", content: "ran again\n" } } : { name: "finish", args: { summary: "Ran again." } };
  }
  if (title.startsWith("[push-other]")) {
    return turn === 0 ? { name: "run_command", args: { command: "git push origin main" } } : { name: "finish", args: { summary: "Tried to push." } };
  }
  if (title.startsWith("[push-run]")) {
    return turn === 0 ? { name: "run_command", args: { command: "git push" } } : { name: "finish", args: { summary: "Pushed." } };
  }
  if (title.startsWith("[net]")) {
    return turn === 0 ? { name: "run_command", args: { command: "git fetch" } } : { name: "finish", args: { summary: "Tried the network." } };
  }
  if (title.startsWith("[fresh]")) {
    return turn === 0
      ? { name: "write_file", args: { path: "note.txt", content: "hello from a folder with no repo\n" } }
      : { name: "finish", args: { summary: "Wrote a note." } };
  }
  return { name: "finish", args: { summary: "Nothing to do." } };
}

export async function startStubRuntime(): Promise<StubRuntime> {
  const calls = new Map<string, number>();
  const fast = new Set<string>();
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (req.url === "/health") return void res.end("ok");
      if (req.url !== "/api/chat/tools") {
        res.statusCode = 404;
        return void res.end("{}");
      }
      const body = JSON.parse(raw) as { messages: ChatMessage[] };
      const brief = body.messages.find((message) => message.role === "user" && String(message.content).includes("# Task:"));
      const title = /# Task: (.+)/.exec(String(brief?.content ?? ""))?.[1]?.trim() ?? "";
      calls.set(title, (calls.get(title) ?? 0) + 1);
      const turn = body.messages.filter((message) => message.role === "assistant").length;
      const step = script(title, turn, body.messages, fast.has(title));
      if (step === "hang") return;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          text: step ? "" : "Done.",
          toolCalls: step ? [{ id: `call_${turn}`, name: step.name, arguments: JSON.stringify(step.args) }] : [],
          model: "stub-model",
          credits: null,
          tokensIn: 12,
          tokensOut: 4,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    fast,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface Sidecar {
  base: string;
  child: ChildProcess;
  logs: () => string;
  api: <T = Record<string, unknown>>(path: string, init?: { method?: string; json?: unknown }) => Promise<{ status: number; body: T }>;
  stop: (signal?: NodeJS.Signals) => Promise<void>;
}

export async function bootSidecar(root: string, runtimeUrl: string, extraEnv: Record<string, string> = {}): Promise<Sidecar> {
  const discovery = join(root, "api.json");
  rmSync(discovery, { force: true });
  const child = spawn(process.execPath, ["--import", "tsx", "src/desktop/main.ts"], {
    cwd: hub,
    env: {
      ...process.env,
      NODE_ENV: "development",
      ENSEMBLE_DATA_DIR: join(root, "pglite"),
      ENSEMBLE_BACKUP_DIR: join(root, "backups"),
      ENSEMBLE_DISCOVERY_FILE: discovery,
      ENSEMBLE_DESKTOP_TOKEN: TOKEN,
      ENSEMBLE_WORKSPACE_ROOT: join(root, "workspace"),
      AGENT_RUNTIME_URL: runtimeUrl,
      ENSEMBLE_INPROCESS_RUNTIME: "0",
      REDIS_URL: "memory://desktop",
      HUB_API_PORT: "0",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout?.on("data", (chunk) => (logs += chunk.toString()));
  child.stderr?.on("data", (chunk) => (logs += chunk.toString()));
  const started = Date.now();
  while (!existsSync(discovery)) {
    if (child.exitCode !== null) throw new Error(`sidecar exited early:\n${logs.slice(-3000)}`);
    if (Date.now() - started > 150_000) throw new Error(`sidecar did not start:\n${logs.slice(-3000)}`);
    await sleep(200);
  }
  const { port } = JSON.parse(readFileSync(discovery, "utf8")) as { port: number };
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    child,
    logs: () => logs,
    api: async (path, init = {}) => {
      const response = await fetch(`${base}${path}`, {
        method: init.method ?? (init.json === undefined ? "GET" : "POST"),
        headers: { authorization: `Bearer ${TOKEN}`, ...(init.json === undefined ? {} : { "content-type": "application/json" }) },
        body: init.json === undefined ? undefined : JSON.stringify(init.json),
      });
      const text = await response.text();
      return { status: response.status, body: (text ? JSON.parse(text) : {}) as never };
    },
    stop: async (signal = "SIGTERM") => {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill(signal);
      await exited;
    },
  };
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" }).toString().trim();

export function makeSourceRepo(root: string): string {
  const repo = join(root, "source-repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "--quiet");
  writeFileSync(join(repo, "hello.txt"), "hello\n");
  git(repo, "add", "hello.txt");
  git(repo, "commit", "--quiet", "-m", "start");
  return repo;
}

export async function prepareAccount(side: Sidecar): Promise<void> {
  for (const id of ["workspace", "code"]) {
    const toggled = await side.api("/api/settings/modules", { method: "PUT", json: { id, on: true } });
    assert.equal(toggled.status, 200, JSON.stringify(toggled.body));
  }
}

