import { randomBytes, randomInt } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { sha256 } from "./auth.js";

export type EmailKind = "verify" | "reset";
type Message = { to: string; subject: string; text: string };
type MailSender = (message: Message) => Promise<void>;
let testSender: MailSender | null = null;
export const VERIFY_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const VERIFY_CODE_LENGTH = 4;

export function setMailSenderForTests(sender: MailSender | null): void {
  testSender = sender;
}

export function authWebOrigin(): string {
  const url = new URL(process.env.HUB_WEB_ORIGIN ?? "http://localhost:3000");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("HUB_WEB_ORIGIN must be one exact http(s) origin.");
  }
  return url.origin;
}

export function emailConfigured(): boolean {
  return Boolean(testSender || (process.env.EMAIL_PROVIDER === "resend" && process.env.EMAIL_API_KEY?.trim() && process.env.EMAIL_FROM?.trim()));
}

export function requireEmailConfigured(): void {
  if (!emailConfigured()) {
    throw Object.assign(new Error("Email delivery is not configured. Contact the operator before creating an email account or resetting a password."), {
      statusCode: 503,
      code: "EMAIL_NOT_CONFIGURED",
    });
  }
}

async function sendMail(message: Message): Promise<void> {
  if (testSender) return testSender(message);
  requireEmailConfigured();
  const from = z.string().trim().min(1).refine((value) => !/[\r\n]/.test(value)).parse(process.env.EMAIL_FROM);
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.EMAIL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw Object.assign(new Error("The verification/reset email could not be delivered. Try again shortly.", { cause }), {
      statusCode: 503,
      code: "EMAIL_DELIVERY_FAILED",
    });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`The email service rejected delivery (HTTP ${response.status}). Contact the operator or try again shortly.`), {
      statusCode: 503,
      code: "EMAIL_DELIVERY_FAILED",
    });
  }
}

function newVerifyCode(): string {
  let code = "";
  for (let index = 0; index < VERIFY_CODE_LENGTH; index += 1) {
    code += VERIFY_CODE_ALPHABET[randomInt(VERIFY_CODE_ALPHABET.length)];
  }
  return code;
}

export function verifyCodeTokenId(userId: string, code: string): string {
  return sha256(`verify:${userId}:${code}`);
}

export async function sendAccountEmail(prisma: PrismaClient, user: { id: string; email: string }, kind: EmailKind): Promise<void> {
  requireEmailConfigured();
  const token = kind === "verify" ? newVerifyCode() : randomBytes(32).toString("base64url");
  const lifetime = 30 * 60_000;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { id: user.id } });
    await tx.emailToken.deleteMany({ where: { OR: [{ userId: user.id, kind }, { expiresAt: { lte: now } }] } });
    await tx.emailToken.create({
      data: {
        id: kind === "verify" ? verifyCodeTokenId(user.id, token) : sha256(token),
        userId: user.id,
        kind,
        expiresAt: new Date(now.getTime() + lifetime),
      },
    });
  });
  const url = new URL(kind === "verify" ? "/verify" : "/reset", authWebOrigin());
  if (kind === "reset") {
    // The fragment is not sent in proxy logs or Referer headers.
    url.hash = new URLSearchParams({ token }).toString();
  }
  await sendMail({
    to: user.email,
    subject: kind === "verify" ? `Your Ensemble code: ${token}` : "Reset your Ensemble password",
    text: kind === "verify"
      ? `Your Ensemble verification code is ${token}.\n\nIt expires in 30 minutes. Enter it on the Ensemble verify page:\n\n${url}\n\nIf you did not sign up for Ensemble, ignore this email.`
      : `Reset your Ensemble password:\n\n${url}\n\nThis link expires in 30 minutes and can be used once. If you did not request this reset, ignore this email.`,
  });
}
