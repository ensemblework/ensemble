import { randomInt } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { sha256 } from "../lib/auth.js";
import { PAIRING_MS } from "./constants.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
type PairingPrisma = PrismaClient | Prisma.TransactionClient;

export function pairingCode(): string {
  let code = "";
  for (let i = 0; i < 8; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

export async function createDevicePairing(prisma: PairingPrisma, userId: string, now = new Date()) {
  const code = pairingCode();
  const expiresAt = new Date(now.getTime() + PAIRING_MS);
  const pairing = await prisma.devicePairing.create({ data: { userId, codeHash: sha256(code), expiresAt } });
  return { code, expiresAt, pairing };
}
