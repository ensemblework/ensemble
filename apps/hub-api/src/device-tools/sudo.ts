/**
 * A node's `sudo` call (nodeTools 2): one command as the administrator, which the owner approved on a
 * card in the chat, with its exact text. It never runs in the OS sandbox (it could not become the
 * administrator there), so the hard floor refuses the dangerous commands as the administrator
 * (device-tools/dangerous.ts) whatever the owner answered, and the command must be the one the card
 * showed (`commandHash`). The owner's password, when they gave one, comes sealed in their browser for
 * this computer (purpose "sudo", the card as the decision, the command's hash as the name): opened
 * here only, checked like any sealed box (this computer and its key, a site it trusts, unexpired,
 * taken once) and typed into `sudo -S` on its input, never put in an argument, the environment, a log,
 * the ledger or the output. Without one, `sudo -n` runs only what needs no password. `-k`: sudo never
 * uses a password it remembered from before. Output, the time limit and running on in the background
 * are as for `run` (`deliverCommand`).
 */
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { appendLedger } from "../lib/ledger.js";
import { trustedOrigins } from "../credentials/origins.js";
import { claimOnce } from "../credentials/replay.js";
import { checkAad, openSealed, SealError } from "../credentials/seal.js";
import { loadSealKey } from "../credentials/seal-key.js";
import { remoteApiBase, type HostedClient } from "../remote/client.js";
import { SUDO_PASSWORD_NEEDED, SUDO_PASSWORD_REFUSED, type CodeAnswer, type NodeToolRequest } from "../remote/contract.js";
import { loadSettings } from "../remote/store.js";
import { GuardError } from "../workspace/guard.js";
import { dangerousCommand, dangerousMessage } from "./dangerous.js";
import type { ToolFolder } from "./folders.js";
import { cleanOutput, deliverCommand } from "./run.js";

type SudoRequest = Extract<NodeToolRequest, { tool: "sudo" }>;
type App = Pick<FastifyInstance, "prisma">;
type Spawn = (command: string, args: readonly string[], options: Parameters<typeof spawnProcess>[2]) => ChildProcess;

/** What a sealed sudo box holds. */
const SudoPayload = z.object({ password: z.string().min(1).max(1024) }).strict();

export const SUDO_WINDOWS = "Running as administrator is not available on Windows yet.";
export const PASSWORD_REFUSED = SUDO_PASSWORD_REFUSED;
export const PASSWORD_NEEDED = SUDO_PASSWORD_NEEDED;

/** The system's own sudo: never one found on PATH, where a folder a program can write may come first. */
export function systemSudo(exists: (path: string) => boolean = existsSync): string | null {
  return ["/usr/bin/sudo", "/bin/sudo", "/run/wrappers/bin/sudo"].find((path) => exists(path)) ?? null;
}

/** sudo's arguments: the password read from its input, or none at all; never a remembered one. */
export function sudoArgv(command: string, password: boolean): string[] {
  return password ? ["-S", "-k", "-p", "", "--", "/bin/sh", "-c", command] : ["-n", "-k", "--", "/bin/sh", "-c", command];
}

export function commandHash(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex");
}

/** sudo's own lines (sudo, and sudo-rs as newer Ubuntu ships it) for a password it did not accept. */
const REFUSED = /^(Sorry, try again\.|sudo: \d+ incorrect password attempts?|sudo: no password was provided|sudo: Authentication failed, try again\.|sudo: maximum \d+ incorrect authentication attempts?|sudo: Authentication required but not attempted)\s*$/im;
/** …and for a password it needs, when none was given. */
const NEEDED = /^sudo: (a password is required|interactive authentication is required|a terminal is required to read the password)/im;

/** Why sudo itself refused (its own messages, read in the C locale), or null. */
export function sudoProblem(output: string): string | null {
  if (REFUSED.test(output)) return PASSWORD_REFUSED;
  if (NEEDED.test(output)) return PASSWORD_NEEDED;
  return null;
}

/** Opens the card's sealed password and checks what it is bound to; the password, or a SealError. */
export function openSudoBox(request: Pick<SudoRequest, "cardId" | "commandHash" | "sealed">, now = Date.now()): { password: string; nonce: string; expiresAt: string } {
  if (!request.sealed) throw new SealError("shape", "No password came with this command.");
  const key = loadSealKey();
  if (!key) throw new SealError("key", "This computer has no key for encrypted values. Update Ensemble here, or pair it again.");
  const settings = loadSettings();
  const deviceId = settings.deviceId ?? key.deviceId;
  if (!deviceId) throw new SealError("device", "This computer does not know its own id. Pair it again.");
  const { aad, plaintext } = openSealed(request.sealed, { kid: key.info.kid, privateKey: key.privateKey });
  try {
    checkAad(aad, { deviceId, kid: key.info.kid, decisionId: request.cardId, purpose: "sudo", name: request.commandHash, origins: trustedOrigins(remoteApiBase() ?? settings.apiBase), now });
    let payload: z.infer<typeof SudoPayload>;
    try {
      payload = SudoPayload.parse(JSON.parse(plaintext.toString("utf8")));
    } catch {
      throw new SealError("shape", "The password could not be read.");
    }
    // sudo reads the password up to the end of the line: the rest would be the command's input.
    if (/[\r\n\0]/.test(payload.password)) throw new SealError("shape", "A password with a line break cannot be typed into sudo.");
    return { password: payload.password, nonce: aad.nonce, expiresAt: aad.expiresAt };
  } finally {
    plaintext.fill(0);
  }
}

/** sudo's environment: nothing of this runtime's (no keys, no tokens), C messages that can be read. */
function sudoEnv(): NodeJS.ProcessEnv {
  const user = (() => {
    try {
      return userInfo().username;
    } catch {
      return process.env.USER ?? "";
    }
  })();
  return { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: homedir(), USER: user, LOGNAME: user, LANG: "C", LC_ALL: "C", TERM: "dumb" };
}

/** Starts sudo in its own process group, its output decoded as it comes; resolves with how it ended. */
function runSudo(spawn: Spawn, sudo: string, argv: string[], input: { cwd: string; password: string | null; timeoutSec: number; onChunk: (text: string) => void; signal: AbortSignal }): Promise<{ exitCode: number; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(sudo, argv, { cwd: input.cwd, env: sudoEnv(), stdio: [input.password === null ? "ignore" : "pipe", "pipe", "pipe"], detached: true, windowsHide: true });
    // sudo-rs ends even an empty prompt with a new line, before anything the command prints.
    let prompt = input.password !== null;
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder("utf8");
      stream?.on("data", (chunk: Buffer) => {
        let text = decoder.write(chunk);
        if (stream === child.stderr && prompt && text) {
          prompt = false;
          text = text.replace(/^\r?\n/, "");
        }
        if (text) input.onChunk(text);
      });
      stream?.on("end", () => {
        const rest = decoder.end();
        if (rest) input.onChunk(rest);
      });
    }
    if (input.password !== null && child.stdin) {
      child.stdin.on("error", () => undefined);
      const bytes = Buffer.from(`${input.password}\n`, "utf8");
      // The only copy this module made is wiped once written; the input then ends, so the command reads nothing more.
      child.stdin.end(bytes, () => bytes.fill(0));
    }
    let timedOut = false;
    let killer: NodeJS.Timeout | null = null;
    const stop = () => {
      // sudo passes SIGTERM on to the command; SIGKILL can only end sudo itself.
      signalGroup(child, "SIGTERM");
      killer ??= setTimeout(() => signalGroup(child, "SIGKILL"), 5_000);
      killer.unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, input.timeoutSec * 1000);
    timer.unref?.();
    if (input.signal.aborted) stop();
    input.signal.addEventListener("abort", stop, { once: true });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
      input.signal.removeEventListener("abort", stop);
      resolve({ exitCode: code ?? (signal ? 137 : 1), timedOut });
    });
  });
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/** Whether sudo here runs this user's commands without a password (so a password given must not reach the command's input). */
function needsNoPassword(spawn: Spawn, sudo: string, cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(sudo, ["-n", "-k", "--", "true"], { cwd, env: sudoEnv(), stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
    const timer = setTimeout(() => signalGroup(child, "SIGKILL"), 10_000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export type SudoOptions = { spawn?: Spawn; platform?: string; sudo?: string | null; now?: number };

/**
 * Runs the approved command as the administrator and answers like `run`: 200 with its output (and
 * `error` when sudo refused the password, or needs one), or 202 when it runs on. The ledger keeps
 * the command's hash, the folder and the exit code, nothing else.
 */
export async function runNodeSudo(app: App, client: HostedClient, request: SudoRequest, folder: ToolFolder, answer: (reply: CodeAnswer) => Promise<void>, options: SudoOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return answer({ status: 409, body: { error: SUDO_WINDOWS } });
  const hit = dangerousCommand(request.command, { root: true });
  if (hit) return answer({ status: 403, body: { error: dangerousMessage(hit) } });
  if (commandHash(request.command) !== request.commandHash) throw new GuardError("This is not the command your owner approved.");
  const sudo = options.sudo === undefined ? systemSudo() : options.sudo;
  if (!sudo) return answer({ status: 409, body: { error: "sudo is not installed on this computer." } });
  const spawn = options.spawn ?? (spawnProcess as Spawn);
  let box: ReturnType<typeof openSudoBox> | null = null;
  let claim: { release: () => Promise<void> } | null = null;
  if (request.sealed) {
    try {
      box = openSudoBox(request, options.now);
      claim = await claimOnce({ decisionId: request.cardId, nonce: box.nonce, expiresAt: box.expiresAt }, options.now);
    } catch (error) {
      if (!(error instanceof SealError)) throw error;
      await appendLedger({ userId: env.ENSEMBLE_DEV_USER_ID, actor: "system", action: "node.tool.sudo_refused", payload: { nodeId: request.nodeId, reason: error.code } }).catch(() => undefined);
      return answer({ status: error.statusCode, body: { error: error.message, code: `seal_${error.code}` } });
    }
  }
  // Where sudo needs no password, one given is never typed: the command would read it as its input.
  const password = box && !(await needsNoPassword(spawn, sudo, folder.path)) ? box.password : null;
  const scrub = (text: string) => cleanOutput(box ? text.split(box.password).join("[hidden]") : text);
  let problem: string | null = null;
  const result = await deliverCommand(
    client,
    {
      runId: request.runId,
      background: false,
      timeoutSec: request.timeoutSec,
      clean: scrub,
      inline: ({ exitCode, output }) => {
        problem = exitCode === 0 ? null : sudoProblem(output);
        return problem ? { error: problem } : {};
      },
    },
    ({ onChunk, signal }) => runSudo(spawn, sudo, sudoArgv(request.command, password !== null), { cwd: folder.path, password, timeoutSec: request.timeoutSec, onChunk, signal }),
    answer,
  );
  if (problem === null && result.exitCode !== 0) problem = sudoProblem(result.output);
  // A password that was not accepted leaves the card open for another try, with a new box.
  if (problem === PASSWORD_REFUSED) await claim?.release().catch(() => undefined);
  box = null;
  await appendLedger({ userId: env.ENSEMBLE_DEV_USER_ID, actor: "agent", action: "node.tool.sudo", payload: { nodeId: request.nodeId, commandSha256: request.commandHash, folder: folder.label, exitCode: result.exitCode } }).catch(() => undefined);
}
