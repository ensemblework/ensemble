/**
 * Confirm before sending (ensemble-node design E§8.5): checks in code that run before media goes
 * to the owner, each in the StepReport `Check` shape (node/report.ts), so a failure is a failed
 * verification and the repair loop runs. The app checks live with the app registry (service.ts).
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Check } from "../node/report.js";
import { findFfmpegs, type FfmpegInfo } from "./ffmpeg.js";
import { imageInfo, pngStats, type ImageStats } from "./probe.js";

/** Most of the image one colour, or almost no contrast: nothing was drawn. */
export const BLANK_SHARE = 0.995;
export const BLANK_STD_DEV = 1.5;

export function blankVerdict(stats: ImageStats): { blank: boolean; detail: string } {
  const share = (stats.dominant.share * 100).toFixed(1);
  if (stats.dominant.share >= BLANK_SHARE || stats.stdDev < BLANK_STD_DEV) {
    return { blank: true, detail: `The image is blank: ${share}% of it is ${stats.dominant.hex} (contrast ${stats.stdDev.toFixed(1)}).` };
  }
  return { blank: false, detail: `${stats.width}×${stats.height}, ${stats.colours} colours, contrast ${stats.stdDev.toFixed(1)}; the most common colour covers ${share}%.` };
}

async function asPng(bytes: Buffer, tools?: FfmpegInfo[]): Promise<Buffer | null> {
  const info = imageInfo(bytes);
  if (info?.format === "png") return bytes;
  if (info?.format !== "jpeg") return null;
  const tool = (tools ?? (await findFfmpegs())).find((candidate) => candidate.jpegFrames && candidate.png);
  return tool ? jpegToPng(tool.path, bytes) : null;
}

/** One JPEG decoded to PNG by ffmpeg, through pipes. */
function jpegToPng(ffmpeg: string, jpeg: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-i", "pipe:0", "-frames:v", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(jpeg);
  });
}

/** The image is not blank or one colour. JPEG is read through ffmpeg; other formats are skipped. */
export async function checkImage(path: string, options: { name?: string; id?: string; tools?: FfmpegInfo[] } = {}): Promise<Check> {
  const base = { ...(options.id ? { id: options.id } : {}), name: options.name ?? "The screenshot is not blank", evidence: [basename(path)] };
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    return { ...base, verdict: "blocked", detail: `Could not read ${basename(path)}: ${(error as NodeJS.ErrnoException).code ?? String(error)}.` };
  }
  const png = await asPng(bytes, options.tools).catch(() => null);
  if (!png) return { ...base, verdict: "skipped", detail: "This image format cannot be checked here." };
  try {
    const verdict = blankVerdict(await pngStats(png));
    return { ...base, verdict: verdict.blank ? "fail" : "pass", detail: verdict.detail };
  } catch (error) {
    return { ...base, verdict: "skipped", detail: `The image could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const normalise = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Every expected string appears in the text (case and spacing ignored). */
export function checkTextIn(text: string, expected: string[], options: { name?: string; id?: string } = {}): Check {
  const haystack = normalise(text);
  const wanted = expected.map((item) => item.trim()).filter(Boolean);
  const missing = wanted.filter((item) => !haystack.includes(normalise(item)));
  const base = { ...(options.id ? { id: options.id } : {}), name: options.name ?? "Shows the expected text" };
  if (!wanted.length) return { ...base, verdict: "skipped", detail: "No text was given to look for." };
  if (missing.length) return { ...base, verdict: "fail", detail: `Not found: ${missing.map((item) => `“${item.slice(0, 120)}”`).join(", ")}.`.slice(0, 2_000) };
  return { ...base, verdict: "pass", detail: `Found ${wanted.map((item) => `“${item.slice(0, 80)}”`).join(", ")}.`.slice(0, 2_000) };
}

const CRASH = /segmentation fault|core dumped|traceback \(most recent call last\)|uncaught (?:exception|error)|unhandled (?:promise )?rejection|fatal error|panicked at|a javascript error occurred in the main process/i;

/** The first line of a program's output that says it crashed, or null. */
export function crashLine(output: string): string | null {
  return output.split("\n").find((line) => CRASH.test(line))?.trim().slice(0, 300) ?? null;
}
