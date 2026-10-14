/**
 * The versions of one file the Code tab's editor works from (docs/16 §1–§2): the file before the run
 * (the run's start tree, or the index for a checkout), the run's own version (its end tree), the
 * changes accepted so far (a blob the review keeps), and the file on disk now. Text is given with LF
 * line endings and no byte-order mark; writes put the file's own back. Also a small line diff, used to
 * count the changes still to decide in each file.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { hostExecutable } from "../workspace/policy.js";

/** Larger versions are not loaded into the editor. */
export const VERSION_MAX_BYTES = 5 * 1024 * 1024;

/** Raw bytes of a blob spec (`<tree>:<path>`, `:<path>` for the index, or a sha), or null when there is none. */
export async function gitBlob(repo: string, spec: string, max = VERSION_MAX_BYTES): Promise<Buffer | null> {
  const bin = await hostExecutable("git");
  return new Promise((resolve) => {
    const child = spawn(bin, ["-c", "core.fsmonitor=false", "cat-file", "blob", spec], { cwd: repo, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
    const out: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        tooBig = true;
        child.kill();
        return;
      }
      out.push(chunk);
    });
    child.stderr.resume();
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 && !tooBig ? Buffer.concat(out) : tooBig ? Buffer.alloc(max + 1) : null));
  });
}

/** Stores text as a blob in the repository's object store; returns its sha. Runs no repository code. */
export async function writeBlob(repo: string, content: Buffer): Promise<string> {
  const bin = await hostExecutable("git");
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["-c", "core.fsmonitor=false", "hash-object", "-w", "--no-filters", "--stdin"], { cwd: repo, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim().slice(0, 300) || "git hash-object failed"))));
    child.stdin.end(content);
  });
}

export type Decoded = { text: string; eol: "lf" | "crlf"; bom: boolean; binary: boolean; tooLarge: boolean };

/** Text for the editor: LF line endings, no BOM. Binary (a NUL in the first 8000 bytes) and too-large files carry no text. */
export function decode(bytes: Buffer | null): Decoded | null {
  if (!bytes) return null;
  if (bytes.length > VERSION_MAX_BYTES) return { text: "", eol: "lf", bom: false, binary: false, tooLarge: true };
  if (bytes.subarray(0, 8000).includes(0)) return { text: "", eol: "lf", bom: false, binary: true, tooLarge: false };
  let text = bytes.toString("utf8");
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  const eol = crlf > 0 && crlf * 2 >= lf ? "crlf" : "lf";
  return { text: text.replace(/\r\n/g, "\n"), eol, bom, binary: false, tooLarge: false };
}

/** The editor's text written the way the file was: its own line endings and byte-order mark. */
export function encode(text: string, like: { eol: "lf" | "crlf"; bom: boolean } | null): Buffer {
  const body = like?.eol === "crlf" ? text.replace(/\r?\n/g, "\r\n") : text;
  return Buffer.from(`${like?.bom ? "﻿" : ""}${body}`, "utf8");
}

export function hashOf(bytes: Buffer | null): string | null {
  return bytes ? createHash("sha1").update(bytes).digest("hex") : null;
}

/** One changed block between two texts, in lines: a[aStart, aEnd) became b[bStart, bEnd). */
export type Block = { aStart: number; aEnd: number; bStart: number; bEnd: number };

/**
 * Myers' line diff. Past `maxEdits` (very different texts) the whole file is one block, which is
 * still a correct, if coarse, answer.
 */
export function lineBlocks(a: string[], b: string[], maxEdits = 4000): Block[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  const n = A.length;
  const m = B.length;
  if (!n && !m) return [];
  if (!n || !m) return [{ aStart: start, aEnd: endA, bStart: start, bEnd: endB }];
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  let v: Int32Array = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return [{ aStart: start, aEnd: endA, bStart: start, bEnd: endB }];
  // Walk back to the edit script, then group neighbouring edits into blocks.
  const edits: Array<["del", number] | ["ins", number]> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = v[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
    }
    if (x === prevX) edits.push(["ins", prevY]);
    else edits.push(["del", prevX]);
    x = prevX;
    y = prevY;
  }
  edits.reverse();
  const blocks: Block[] = [];
  // Re-run the script forwards, tracking positions in both texts.
  let ai = 0;
  let bi = 0;
  let current: Block | null = null;
  const flush = () => {
    if (current) blocks.push({ aStart: current.aStart + start, aEnd: current.aEnd + start, bStart: current.bStart + start, bEnd: current.bEnd + start });
    current = null;
  };
  for (const [kind, at] of edits) {
    // Advance over equal lines up to this edit.
    if (kind === "del") {
      if (at > ai) {
        flush();
        bi += at - ai;
        ai = at;
      }
      current ??= { aStart: ai, aEnd: ai, bStart: bi, bEnd: bi };
      current.aEnd = ai + 1;
      ai += 1;
    } else {
      if (at > bi) {
        flush();
        ai += at - bi;
        bi = at;
      }
      current ??= { aStart: ai, aEnd: ai, bStart: bi, bEnd: bi };
      current.bEnd = bi + 1;
      bi += 1;
    }
  }
  flush();
  return blocks;
}

/** What a block says: the lines it takes out and the lines it puts in. Equal for the same change wherever it sits. */
export function blockSignature(a: string[], b: string[], block: Block): string {
  return `${a.slice(block.aStart, block.aEnd).join("\n")}\u0000${b.slice(block.bStart, block.bEnd).join("\n")}`;
}

/**
 * The agent's changes still to decide in one file, and your own: blocks between the accepted
 * baseline and the file now that are exactly one of the run's changes (start → end) are pending.
 */
export function reviewCounts(input: { start: string | null; end: string | null; baseline: string | null; current: string | null }): { total: number; pending: number; yours: number } {
  const lines = (text: string | null) => (text === null ? [] : text.split("\n"));
  const start = lines(input.start);
  const end = lines(input.end);
  const agent = new Set(lineBlocks(start, end).map((block) => blockSignature(start, end, block)));
  const base = input.baseline === null ? start : lines(input.baseline);
  const now = lines(input.current);
  let pending = 0;
  let yours = 0;
  for (const block of lineBlocks(base, now)) {
    if (agent.has(blockSignature(base, now, block))) pending += 1;
    else yours += 1;
  }
  return { total: agent.size, pending, yours };
}
