import { spawn } from "node:child_process";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { type CodeEngine } from "@ensemble/shared-types";
import { copilotBinary, withCopilotServer } from "../../subscriptions/copilot.js";
import { antigravityDir } from "../../subscriptions/antigravity.js";
import { agentEnv } from "../../subscriptions/detect.js";
import { ACP_AGENTS } from "./acp.js";
import { codexBinary } from "./codex.js";
import { RpcConnection } from "./rpc.js";

const SessionId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const absentSession = (message: string, id: string) => message.includes(id) && /(?:session|thread)(?:\s+["']?[\w-]+["']?)?\s+(?:not found|does not exist)|(?:session|thread) not found:/i.test(message);

/** Only an exact native history object, never a project, worktree, credentials or profile root. */
async function removeHistory(root: string, parts: string[]): Promise<void> {
  const base = resolve(root);
  let path = base;
  for (const part of parts) {
    if (!part || part === "." || part === ".." || /[/\\]/.test(part)) throw new Error("Invalid native history path.");
    path = join(path, part);
  }
  if (!path.startsWith(base + sep)) throw new Error("Native history must stay inside its provider's history directory.");
  let current = base;
  const targets = [base, ...parts.map(part => current = join(current, part))];
  for (const target of targets) {
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || await realpath(target) !== resolve(target)) throw new Error("Linked native session history cannot be deleted.");
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
  }
  await rm(path, { recursive: true, force: true });
}

async function folders(path: string): Promise<string[]> {
  try { return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name); }
  catch (error) { if (missing(error)) return []; throw error; }
}

async function command(program: string, args: string[], cwd: string, env = process.env): Promise<void> {
  await new Promise<void>((done, reject) => {
    const child = spawn(program, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", data => { output = (output + String(data)).slice(-2000); });
    child.stderr.on("data", data => { output = (output + String(data)).slice(-2000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Native session deletion timed out. Retry after checking the agent on your computer.")); }, 30_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => {
      clearTimeout(timer);
      if (code === 0) done();
      else reject(new Error(`The agent could not delete its session: ${output.trim() || `exit ${code}`}`));
    });
  });
}

async function rpcDelete(program: string, args: string[], env: NodeJS.ProcessEnv, run: (rpc: RpcConnection) => Promise<void>): Promise<void> {
  const child = spawn(program, args, { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const rpc = new RpcConnection(line => {
    if (!child.stdin.writable) return;
    child.stdin.write(line);
  }, { jsonrpc: true });
  child.stdin.on("error", error => rpc.close(error.message));
  child.stderr.resume();
  child.once("error", error => rpc.close(error.message));
  child.once("exit", () => rpc.close("The agent exited before confirming session deletion."));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => { void rpc.receive(line); });
  const timer = setTimeout(() => { rpc.close("The agent did not confirm deletion in time. Retry after updating or restarting it."); child.kill(); }, 30_000);
  try { await run(rpc); }
  finally {
    clearTimeout(timer); lines?.close(); rpc.close("Deletion connection closed.");
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(done => child.once("exit", () => done()));
      child.kill();
      const force = setTimeout(() => child.kill("SIGKILL"), 2000);
      await exited;
      clearTimeout(force);
    }
  }
}

export async function deleteNativeSession(engine: CodeEngine, sessionId: string, cwd: string): Promise<void> {
  SessionId.parse(sessionId);
  if (engine === "claude-code" || engine === "cursor-agent") {
    if (!uuid.test(sessionId)) throw new Error("This agent's recorded session ID is invalid.");
    const root = engine === "claude-code"
      ? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects")
      : join(homedir(), ".cursor", "chats");
    for (const folder of await folders(root)) {
      await removeHistory(root, [folder, engine === "claude-code" ? `${sessionId}.jsonl` : sessionId]);
      if (engine === "claude-code") await removeHistory(root, [folder, sessionId]);
    }
    return;
  }
  if (engine === "copilot-cli") {
    const program = await copilotBinary();
    if (!program) throw new Error("Install or update GitHub Copilot on this computer to delete its saved session.");
    await withCopilotServer(program, async request => {
      const answer = await request("session.delete", { sessionId });
      if (answer.success !== true && !(typeof answer.error === "string" && absentSession(answer.error, sessionId))) throw new Error(typeof answer.error === "string" ? answer.error : "Copilot did not confirm deletion. Update Copilot and retry.");
    });
    return;
  }
  if (engine === "codex") {
    const program = await codexBinary();
    if (!program) throw new Error("Install or update Codex on this computer to delete its saved thread.");
    await rpcDelete(program, ["app-server"], agentEnv(), async rpc => {
      await rpc.request("initialize", { clientInfo: { name: "ensemble", version: "1" }, capabilities: { experimentalApi: true } });
      rpc.notify("initialized");
      try { await rpc.request("thread/delete", { threadId: sessionId }); }
      catch (error) { if (!(error instanceof Error && absentSession(error.message, sessionId))) throw error; }
    });
    return;
  }
  if (engine === "antigravity") {
    // AGY 1.3.0 paths.py/session_store.py: exact trajectory, sidecar and brain; never its token/config.
    const root = join(antigravityDir(), "home", "antigravity-acp");
    for (const suffix of [".db", ".db-wal", ".db-shm", ".meta"]) await removeHistory(join(root, "conversations"), [`${sessionId}${suffix}`]);
    await removeHistory(join(root, "brain"), [sessionId]);
    return;
  }
  const launch = await ACP_AGENTS[engine].launch({ root: cwd, sandboxed: false, trusted: false });
  if (!launch) throw new Error(`The ${engine} agent is not installed. Install it on this computer and retry deletion.`);
  if (engine === "grok-cli") { await command(launch.program, ["sessions", "delete", sessionId], cwd, launch.env); return; }
  if (engine === "opencode") { await command(launch.program, ["session", "delete", sessionId], cwd, launch.env); return; }
  if (engine === "gemini-cli") { await command(launch.program, ["--delete-session", sessionId], cwd, launch.env); return; }
  throw new Error("This agent has no verified native session deletion method. Its history has not been hidden.");
}
