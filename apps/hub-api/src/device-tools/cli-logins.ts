/**
 * Sign-ins a node's command needs, on this computer (C2, docs/25 §4.10, docs/35 §8.16.4).
 *
 * Codes: the command's output is watched while it runs (device-tools/device-codes.ts); each sign-in code
 * it prints goes to the web for the owner's card, and when the command ends the card says done (it ended
 * well) or expired.
 *
 * Pages: the command runs with `BROWSER` (and `xdg-open`, `sensible-browser`, `x-www-browser`,
 * `www-browser` and `gio open` on Linux, `open` on macOS, first on its `PATH`) set to a small helper in a
 * folder of its own under the commands' temporary folder. The helper hands an http(s) address to this
 * runtime by writing it to a file there (no network) and exits; anything else goes to the real program.
 * The runtime opens the page in the node's browser tab and hands it to the owner as a sign-in
 * (`source: "cli"`): the card's remote view shows it in the clean sign-in browser on this computer, so
 * the command's own callback (`http://localhost:…`) lands here. It is done when a page reaches that
 * address, or when the command ends well; declined or expired, the command is stopped. Only pages on
 * the public web or this computer's own addresses open.
 */
import { chmod, mkdir, open as openFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { existsSync } from "node:fs";
import { browserBroker } from "../browser/index.js";
import { isLoopbackUrl } from "../browser/broker.js";
import { env } from "../config.js";
import { operationEvidenceDir } from "../evidence/files.js";
import { appendLedger } from "../lib/ledger.js";
import { bindDecision, raiseLogin, settleCliLogin, waitForLogin } from "../logins/requests.js";
import { urlMatches } from "../logins/watch.js";
import { safeOrigin } from "../logins/detect.js";
import type { HostedClient } from "../remote/client.js";
import type { NodeToolRequest } from "../remote/contract.js";
import { cacheDir } from "../workspace/guard.js";
import { DeviceCodeWatch, type DeviceCode } from "./device-codes.js";
import { publicWebAddress } from "./http.js";

type RunRequest = Extract<NodeToolRequest, { tool: "run" }>;

/** How often the runtime looks for a page the command handed over. */
const LOOK_MS = 300;
/** Pages one command may open (a command that keeps opening pages is not followed further). */
const MAX_PAGES = 5;
/** Programs that open a page, on Linux. */
const LINUX_OPENERS = ["xdg-open", "sensible-browser", "x-www-browser", "www-browser"];

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The helper: an http(s) address goes to the runtime; anything else to the real program, if there is one. */
function helperScript(urls: string, real: string | null, subcommand?: string): string {
  const match = subcommand ? `[ "$1" = ${quote(subcommand)} ] && shift && ` : "";
  return [
    "#!/bin/sh",
    "# Ensemble: hands a sign-in page to Ensemble on this computer, which opens it for its owner.",
    `${match}for arg in "$@"; do`,
    '  case "$arg" in',
    `    http://*|https://*) printf '%s\\n' "$arg" >> ${quote(urls)}; exit 0 ;;`,
    "  esac",
    "done",
    real ? `exec ${quote(real)} ${subcommand ? `${quote(subcommand)} ` : ""}"$@"` : "exit 1",
    "",
  ].join("\n");
}

/** The real program a helper stands in for, on the command's own PATH. */
function realProgram(name: string, path: string): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Where a command's page sends its answer back, when that is this computer (`redirect_uri=http://localhost:8400`). */
export function loopbackReturn(url: string): string | null {
  try {
    const target = new URL(url).searchParams.get("redirect_uri") ?? new URL(url).searchParams.get("redirect_url");
    if (!target || !isLoopbackUrl(target)) return null;
    return `${new URL(target).origin}/**`;
  } catch {
    return null;
  }
}

/** Tests: what happens to a page a command hands over, instead of the browser. */
let pageOpenerForTests: ((url: string) => Promise<void>) | null = null;
export function setCliPageOpenerForTests(open: ((url: string) => Promise<void>) | null): void {
  pageOpenerForTests = open;
}

export type CommandSignIns = {
  /** For the command's environment: `BROWSER` and the `PATH` with the helpers first (empty where there are none). */
  env: Record<string, string>;
  /** Each piece of the command's output, as it comes. */
  output(text: string): void;
  /** Codes found so far, for the command's answer. */
  codes(): DeviceCode[];
  /** Sign-in pages handed to the owner so far, by site. */
  pages(): string[];
  /** The command ended: its codes and sign-ins say how, and the helpers go. */
  end(exitCode: number): Promise<void>;
};

/**
 * Watches one node command for sign-ins: its codes, and the pages it opens. `stop` ends the command
 * (its sign-in was declined or expired).
 */
export async function commandSignIns(client: HostedClient, request: RunRequest, path: string, stop: () => void): Promise<CommandSignIns> {
  const userId = env.ENSEMBLE_DEV_USER_ID;
  const started = Date.now();
  const command = request.command.slice(0, 200);
  const watch = new DeviceCodeWatch();
  const found: DeviceCode[] = [];
  const logins = new Set<string>();
  const sites: string[] = [];
  const post = (code: DeviceCode, status: "pending" | "done" | "expired") =>
    client.nodeDeviceCode?.({ nodeId: request.nodeId, operation: request.runId, ...(request.operationId ? { operationId: request.operationId } : {}), url: code.url, code: code.code, command, ...(code.expiresInMs ? { expiresAt: new Date(Date.now() + code.expiresInMs).toISOString() } : {}), status }).catch(() => false) ?? Promise.resolve(false);

  let dir: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  const helperEnv: Record<string, string> = {};
  let opened = 0;
  let offset = 0;
  let reading = false;
  // Windows has no shell helper: its commands keep their own browser.
  if (process.platform !== "win32") {
    dir = join(await cacheDir(), "tmp", `ensemble-signin-${request.runId.replace(/[^A-Za-z0-9-]/g, "")}`);
    const bin = join(dir, "bin");
    await mkdir(bin, { recursive: true, mode: 0o700 });
    const urls = join(dir, "urls");
    await writeFile(urls, "", { mode: 0o600 });
    const write = async (name: string, real: string | null, subcommand?: string) => {
      const file = join(bin, name);
      await writeFile(file, helperScript(urls, real, subcommand), { mode: 0o700 });
      await chmod(file, 0o700);
    };
    await write("ensemble-browser", null);
    if (process.platform === "darwin") await write("open", realProgram("open", path) ?? "/usr/bin/open");
    else {
      for (const name of LINUX_OPENERS) await write(name, realProgram(name, path));
      const gio = realProgram("gio", path);
      if (gio) await write("gio", gio, "open");
    }
    helperEnv.BROWSER = join(bin, "ensemble-browser");
    helperEnv.PATH = `${bin}${delimiter}${path}`;
    timer = setInterval(() => void look(urls), LOOK_MS);
    timer.unref();
  }

  async function look(urls: string): Promise<void> {
    if (reading) return;
    reading = true;
    try {
      const handle = await openFile(urls, "r");
      try {
        const { size } = await handle.stat();
        if (size <= offset) return;
        const buffer = Buffer.alloc(Math.min(size - offset, 64 * 1024));
        await handle.read(buffer, 0, buffer.length, offset);
        const text = buffer.toString("utf8");
        const end = text.lastIndexOf("\n");
        if (end < 0) return;
        offset += Buffer.byteLength(text.slice(0, end + 1));
        for (const line of text.slice(0, end).split("\n")) if (line.trim()) await page(line.trim());
      } finally {
        await handle.close();
      }
    } catch {
      // The file went with the command.
    } finally {
      reading = false;
    }
  }

  /** A page the command opened: in the node's browser, handed to the owner to sign in. */
  async function page(url: string): Promise<void> {
    if (opened >= MAX_PAGES || url.length > 8_000) return;
    if (pageOpenerForTests) {
      opened += 1;
      sites.push(safeOrigin(url) ?? url);
      return pageOpenerForTests(url);
    }
    const origin = safeOrigin(url);
    if (!origin || !(isLoopbackUrl(url) || (url.startsWith("https://") && (await publicWebAddress(url))))) {
      await appendLedger({ userId, actor: "agent", action: "node.cli_login.refused", payload: { nodeId: request.nodeId, origin: origin ?? null } }).catch(() => undefined);
      return;
    }
    opened += 1;
    const operation = `node:${request.nodeId}:own`;
    const broker = browserBroker();
    broker.operation(operation, { evidenceDir: operationEvidenceDir(operation) });
    const tab = await broker.open(operation, url, { profile: "default" }).catch(() => null);
    if (!tab || tab.error) return;
    const now = broker.ownerTab(tab.tab).page.url();
    const back = loopbackReturn(url);
    // Signed in already (the browser's own session answered at once): the command has its answer.
    if (back && urlMatches(back, now)) {
      await broker.close(operation, tab.tab).catch(() => undefined);
      return;
    }
    // It waits as long as the command may run: the card's time is the command's.
    const login = await raiseLogin(broker, { operation, tab: tab.tab, origin: safeOrigin(now) ?? origin, reasons: [`\`${command}\` opened this sign-in page`], purpose: "sign_in", signedIn: back ? { urlPattern: back } : null, pageAsked: true, cli: true, waitMs: Math.max(0, started + request.timeoutSec * 1000 - Date.now()) });
    logins.add(login.loginId);
    sites.push(login.origin);
    await appendLedger({ userId, actor: "agent", action: "node.cli_login", payload: { nodeId: request.nodeId, origin: login.origin, operation } }).catch(() => undefined);
    const raised = await client.nodeCliLogin?.({ nodeId: request.nodeId, operation: request.runId, ...(request.operationId ? { operationId: request.operationId } : {}), login: { ...login, source: "cli", command } }).catch(() => null);
    if (raised?.decisionId) bindDecision(login.loginId, raised.decisionId);
    // Not now, or nobody signed in in time: the command would wait for nothing.
    void waitForLogin(login.loginId).then((outcome) => {
      if (outcome.status === "declined" || outcome.status === "expired") stop();
    });
  }

  return {
    env: helperEnv,
    output(text) {
      for (const code of watch.feed(text)) {
        found.push(code);
        void post(code, "pending");
      }
    },
    codes: () => [...found],
    pages: () => [...sites],
    async end(exitCode) {
      if (timer) clearInterval(timer);
      if (dir) {
        const urls = join(dir, "urls");
        await look(urls);
      }
      for (const code of found) await post(code, exitCode === 0 ? "done" : "expired");
      for (const id of logins) await settleCliLogin(id, exitCode === 0, exitCode === 0 ? `\`${command}\` finished: signed in.` : `\`${command}\` ended (exit code ${exitCode}).`).catch(() => undefined);
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
