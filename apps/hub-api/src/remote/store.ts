/**
 * What the Mac keeps for remote tasks. The switches and the shared folders
 * live in the app-data folder (doc 25 §2: the server cannot turn them on).
 * The device token is a `model_credentials` row, encrypted with the same
 * helper as the git token, and is only ever read into this process.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "../config.js";
import { decrypt, encrypt } from "../lib/secrets.js";
import { prisma } from "../lib/prisma.js";

export const DEVICE_TOKEN_PROVIDER = "ensemble_device";

export type SharedFolder = {
  label: string;
  path: string;
  /** folder: the agent works in place. repo: the agent works in a run clone and may push its run branch back here. */
  kind: "folder" | "repo";
  access: "review" | "read-write";
};

export interface RemoteSettings {
  version: 1;
  /** "Allow remote tasks". Off until the person turns it on, on this Mac. */
  enabled: boolean;
  /** §5.1 run-branch push. Off by default, Mac only. */
  runBranchPush: boolean;
  apiBase: string | null;
  deviceId: string | null;
  deviceName: string;
  pairedAt: string | null;
  folders: SharedFolder[];
  disconnected: { at: string; reason: string } | null;
  /** The web could not be reached. The token stays, and the loop keeps trying. */
  unreachable: string | null;
}

export type MirroredDecision = { hostedId: string; hash: string; risk: "ordinary" | "high"; settled: boolean };

export interface HeldJob {
  hostedId: string;
  leaseToken: string;
  localJobId: string | null;
  claimedAt: number;
  /** Last write the server accepted for this job (or the last heartbeat that listed it). */
  lastOkAt: number;
  phase: "active" | "completing" | "done";
  sentStatus: string | null;
  sentProgress: string | null;
  sentAt: number;
  eventSeq: string;
  logOffset: number;
  logBytes: number;
  logSeq: number;
  decisions: Record<string, MirroredDecision>;
  /** Set when the Mac refused the spec before a local job existed. */
  refusal?: { code: string; message: string };
}

export function stateDir(): string {
  const explicit = process.env.ENSEMBLE_REMOTE_STATE_DIR?.trim();
  if (explicit) return explicit;
  const data = process.env.ENSEMBLE_DATA_DIR?.trim();
  return data ? dirname(data) : join(process.cwd(), ".ensemble-remote");
}

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

const settingsPath = () => join(stateDir(), "remote.json");
const jobsPath = () => join(stateDir(), "remote-jobs.json");

export function defaultDeviceName(): string {
  const host = process.env.HOSTNAME || process.env.COMPUTERNAME || "";
  const clean = host.replace(/\.local$/, "").replace(/[^\w .-]/g, "").slice(0, 60);
  return clean || (process.platform === "darwin" ? "My Mac" : "My computer");
}

export function loadSettings(): RemoteSettings {
  const saved = readJson<Partial<RemoteSettings>>(settingsPath()) ?? {};
  return {
    version: 1,
    enabled: saved.enabled === true,
    runBranchPush: saved.runBranchPush === true,
    apiBase: typeof saved.apiBase === "string" ? saved.apiBase : null,
    deviceId: typeof saved.deviceId === "string" ? saved.deviceId : null,
    deviceName: typeof saved.deviceName === "string" && saved.deviceName ? saved.deviceName : defaultDeviceName(),
    pairedAt: typeof saved.pairedAt === "string" ? saved.pairedAt : null,
    folders: Array.isArray(saved.folders) ? saved.folders.filter((row): row is SharedFolder => typeof row?.label === "string" && typeof row?.path === "string") : [],
    disconnected: saved.disconnected && typeof saved.disconnected.reason === "string" ? saved.disconnected : null,
    unreachable: typeof saved.unreachable === "string" ? saved.unreachable : null,
  };
}

export function saveSettings(next: RemoteSettings): RemoteSettings {
  writeAtomic(settingsPath(), next);
  return next;
}

export function updateSettings(change: Partial<RemoteSettings>): RemoteSettings {
  return saveSettings({ ...loadSettings(), ...change });
}

export function loadHeld(): Record<string, HeldJob> {
  return readJson<{ jobs?: Record<string, HeldJob> }>(jobsPath())?.jobs ?? {};
}

export function saveHeld(jobs: Record<string, HeldJob>): void {
  writeAtomic(jobsPath(), { jobs });
}

export async function readDeviceToken(): Promise<string | null> {
  const row = await prisma.modelCredential.findUnique({ where: { userId_provider: { userId: env.ENSEMBLE_DEV_USER_ID, provider: DEVICE_TOKEN_PROVIDER } } });
  if (!row?.secret) return null;
  try {
    return decrypt(row.secret) || null;
  } catch {
    return null;
  }
}

export async function saveDeviceToken(token: string, apiBase: string): Promise<void> {
  const userId = env.ENSEMBLE_DEV_USER_ID;
  const hint = `${token.slice(0, 8)}…`;
  await prisma.modelCredential.upsert({
    where: { userId_provider: { userId, provider: DEVICE_TOKEN_PROVIDER } },
    create: { userId, provider: DEVICE_TOKEN_PROVIDER, secret: encrypt(token), hint, baseUrl: apiBase },
    update: { secret: encrypt(token), hint, baseUrl: apiBase, updatedAt: new Date() },
  });
}

export async function dropDeviceToken(): Promise<void> {
  await prisma.modelCredential.deleteMany({ where: { userId: env.ENSEMBLE_DEV_USER_ID, provider: DEVICE_TOKEN_PROVIDER } });
}
