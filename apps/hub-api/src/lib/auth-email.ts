import { randomBytes, randomInt } from "node:crypto";
import { nodeWebOrigin } from "./node-origin.js";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { sha256 } from "./auth.js";
import { sendMail } from "./resend-email.js";

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

function accountMailConfig() {
  const apiKey = process.env.EMAIL_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  return process.env.EMAIL_PROVIDER === "resend" && apiKey && from ? { apiKey, from } : null;
}

export function emailConfigured(): boolean {
  return Boolean(testSender || accountMailConfig());
}

export function requireEmailConfigured(): void {
  if (!emailConfigured()) throw emailNotConfigured();
}

function emailNotConfigured() {
  return Object.assign(new Error("Email delivery is not configured. Contact the operator before creating an email account or resetting a password."), {
    statusCode: 503,
    code: "EMAIL_NOT_CONFIGURED",
  });
}

async function sendAccountMessage(message: Message): Promise<void> {
  if (testSender) return testSender(message);
  const config = accountMailConfig();
  if (!config) throw emailNotConfigured();
  const from = z.string().refine((value) => !/[\r\n]/.test(value)).parse(config.from);
  let response: Response;
  try {
    response = await sendMail({ ...message, from, to: [message.to] }, config.apiKey);
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

/**
 * site "node": the person signed up on Ensemble Node, so the code link opens Node's welcome page
 * (ENSEMBLE_NODE_WEB_ORIGIN) instead of the Hub's verify page. The code works on either.
 */
export async function sendAccountEmail(prisma: PrismaClient, user: { id: string; email: string }, kind: EmailKind, site: "hub" | "node" = "hub"): Promise<void> {
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
  const node = kind === "verify" && site === "node" ? nodeWebOrigin() : null;
  const url = node ? new URL("/welcome", node) : new URL(kind === "verify" ? "/verify" : "/reset", authWebOrigin());
  if (kind === "reset") {
    // The fragment is not sent in proxy logs or Referer headers.
    url.hash = new URLSearchParams({ token }).toString();
  }
  await sendAccountMessage({
    to: user.email,
    subject: kind === "verify" ? `Your Ensemble code: ${token}` : "Reset your Ensemble password",
    text: kind === "verify"
      ? `Your Ensemble verification code is ${token}.\n\nIt expires in 30 minutes. Enter it on ${node ? "Ensemble Node" : "the Ensemble verify page"}:\n\n${url}\n\nIf you did not sign up for Ensemble, ignore this email.`
      : `Reset your Ensemble password:\n\n${url}\n\nThis link expires in 30 minutes and can be used once. If you did not request this reset, ignore this email.`,
  });
}

/**
 * A one-time code that proves the person reads this account's mail, for adding a passkey to the web
 * terminal when the account has no password (Google or GitHub sign-in). The caller keeps its hash.
 */
export function newPasskeyCode(): string {
  let code = "";
  for (let index = 0; index < 6; index += 1) code += VERIFY_CODE_ALPHABET[randomInt(VERIFY_CODE_ALPHABET.length)];
  return code;
}

export async function sendPasskeyCode(user: { email: string }, code: string): Promise<void> {
  requireEmailConfigured();
  await sendAccountMessage({
    to: user.email,
    subject: `Your Ensemble code to add a passkey: ${code}`,
    text: `Someone signed in as you asked to add a passkey for the terminal in Ensemble's Code tab.\n\nThe code is ${code}. It expires in 10 minutes.\n\nIf this was not you, do not enter it anywhere, and change how you sign in to Ensemble.`,
  });
}
