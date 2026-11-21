/**
 * Helpers the tasks share: what counts as looking something up, the files and pictures that reached
 * the chat, test runs in a fixture project, and the conditions timed messages wait for.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { okTool, run } from "../lib/grade.js";
import type { Evidence, TaskContext } from "../lib/types.js";

/** The agent's own web tools, or Ensemble's web and browser tools, ran. */
export function webLookup(ev: Evidence): boolean {
  return ev.agentTools.some((call) => /(^|[-_.])(web_search|web_fetch|fetch|search|browser_navigate)$/i.test(call.name) && !/ensemble/i.test(call.name)) || okTool(ev, /^(hub_web_search|web_search|hub_read_web_page|browser_[a-z_]+|web_task)$/);
}

/**
 * The HTTP status a link answers with after redirects, 0 when nothing answers. curl first: some sites
 * never finish a TLS handshake with Node's fetch, and a link is not dead because of that.
 */
export async function linkStatus(url: string): Promise<number> {
  const curl = await run("curl", ["-s", "-L", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "20", "-A", "Mozilla/5.0 (ensemble-node-eval)", url], { cwd: ".", timeoutMs: 30_000 });
  const status = Number(curl.output.trim());
  if (curl.code === 0 && status > 0) return status;
  return fetch(url, { method: "GET", redirect: "follow", headers: { "user-agent": "ensemble-node-eval" }, signal: AbortSignal.timeout(20_000) }).then((response) => response.status, () => 0);
}

/** The last answer (to the owner's last message). */
export const lastAnswer = (ev: Evidence): string => ev.answers.at(-1) ?? ev.replies.at(-1) ?? "";

export type Shared = { name: string | null; mime: string | null; size: number; text: string | null; image: { format: string; width: number; height: number } | null; error?: string };

/** Width and height of a PNG, JPEG or WebP picture; null for anything else. */
export function imageInfo(bytes: Buffer): Shared["image"] {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) return { format: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) break;
      const marker = bytes[at + 1]!;
      const length = bytes.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { format: "jpeg", width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
      at += 2 + length;
    }
    return { format: "jpeg", width: 0, height: 0 };
  }
  if (bytes.length > 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return { format: "webp", width: 0, height: 0 };
  return null;
}

/** The files and pictures the nodes put in the chat, read as the owner reads them (the evidence route). */
export async function sharedFiles(ctx: TaskContext, ev: Evidence): Promise<Shared[]> {
  const out: Shared[] = [];
  for (const message of ev.messages.filter((row) => row.author.startsWith("node"))) {
    for (const item of message.media) {
      if (!item.evidenceId) continue;
      const response = await ctx.owner.inject({ method: "GET", url: `/api/node/evidence/${item.evidenceId}?message=${message.id}` });
      if (response.statusCode >= 300) {
        out.push({ name: item.name, mime: item.mime, size: item.size ?? 0, text: null, image: null, error: `${response.statusCode}` });
        continue;
      }
      const bytes = response.rawPayload;
      const image = imageInfo(bytes);
      const text = !image && bytes.length < 200_000 && !bytes.subarray(0, 2000).includes(0) ? bytes.toString("utf8").slice(0, 4000) : null;
      out.push({ name: item.name, mime: item.mime ?? response.headers["content-type"]?.toString() ?? null, size: bytes.length, text, image });
    }
  }
  return out;
}

/** Runs `node --test` with these files (or the project's own tests); passes when the run exits 0. */
export async function nodeTests(cwd: string, files: string[] = []): Promise<{ pass: boolean; summary: string }> {
  const result = await run(process.execPath, ["--test", ...files], { cwd, timeoutMs: 120_000 });
  const lines = result.output.split("\n");
  const summary = lines.filter((line) => /^# (tests|pass|fail)\b/.test(line) || /^not ok\b/.test(line)).slice(0, 12).join("; ");
  return { pass: result.code === 0, summary: summary || result.output.slice(-400) };
}

/**
 * Tests the project never saw, written to a folder of their own at grading time, run against the
 * project's module by its path.
 */
export async function hiddenTests(ctx: TaskContext, name: string, source: string): Promise<{ pass: boolean; summary: string }> {
  const folder = join(ctx.world.dirs.root, "hidden", `${ctx.task.id}-${ctx.repeat}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(folder, name), source);
  return nodeTests(folder, [join(folder, name)]);
}

export const sha256 = (path: string): string | null => (existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null);

/** Files under a folder (skipping node_modules and .git), relative paths. */
export function filesIn(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".git") return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesIn(path, `${prefix}${entry.name}/`);
    return entry.isFile() ? [`${prefix}${entry.name}`] : [];
  });
}

export const readText = (path: string, max = 20_000): string | null => (existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8").slice(0, max) : null);

/** A coding run for the owner that has been running at least `seconds`, so its agent is at work (what a timed message waits for). */
export function codingRunningFor(seconds: number): (ctx: TaskContext) => Promise<string | null> {
  return async (ctx) => {
    const job = await ctx.world.prisma.workspaceJob.findFirst({ where: { userId: ctx.owner.id, status: "running", startedAt: { lte: new Date(Date.now() - seconds * 1000) } }, select: { id: true, provider: true } });
    return job ? `${job.provider} run ${job.id.slice(0, 8)} has been running for ${seconds} s` : null;
  };
}
