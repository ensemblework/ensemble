/**
 * A computer paired again (signed out and in, re-paired after an upgrade) gets a new device row,
 * and the runs it made before still live on it: their folders, reviews and the local record that
 * maps them. The current pairing of the same computer is the person's active device with the same
 * install id (`capabilities.installId`, kept by the computer through unpairing); for pairings made
 * before computers reported one, the newest active device with the same name and platform paired
 * after it. A different install id is a different computer, never a successor.
 */
import type { Device, Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export function installIdOf(capabilities: unknown): string | null {
  const value = capabilities && typeof capabilities === "object" ? (capabilities as { installId?: unknown }).installId : null;
  return typeof value === "string" && value ? value : null;
}

/** The device itself while paired; else its successor, or null when that computer is no longer paired at all. */
export async function currentDevice(db: Db, device: Device): Promise<Device | null> {
  if (!device.revokedAt) return device;
  const install = installIdOf(device.capabilities);
  const candidates = await db.device.findMany({ where: { userId: device.userId, revokedAt: null, createdAt: { gte: device.createdAt } }, orderBy: { createdAt: "desc" }, take: 20 });
  if (install) return candidates.find((candidate) => installIdOf(candidate.capabilities) === install) ?? null;
  // Paired before install ids: the same name and platform, or (renamed since) the only computer on that platform.
  const samePlatform = candidates.filter((candidate) => candidate.platform === device.platform);
  return samePlatform.find((candidate) => candidate.name === device.name) ?? (samePlatform.length === 1 ? samePlatform[0]! : null);
}

/** The same for many devices at once (a list of runs): id → the paired device to use. */
export async function currentDevices(db: Db, devices: Device[]): Promise<Map<string, Device | null>> {
  const out = new Map<string, Device | null>();
  for (const device of devices) if (!out.has(device.id)) out.set(device.id, await currentDevice(db, device));
  return out;
}
