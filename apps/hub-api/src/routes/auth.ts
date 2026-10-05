import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { envDevTools } from "../lib/dev-tools.js";
import { requireBrowserSession } from "../bridge/auth.js";
import { endSession, hashPassword, newApiToken, startSession, verifyPassword } from "../lib/auth.js";
import { INVITE_ONLY, signupMode, signupPermitted } from "../lib/signup.js";
import { revokePairedDevice } from "../devices/revoke.js";
import { appendLedger } from "../lib/ledger.js";
import { loadSettings, saveSettings } from "../lib/settings.js";

const Credentials = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  password: z.string().min(8, "Use at least 8 characters."),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  const realAccounts = () => prisma.user.count({ where: { passwordHash: { not: null } } });

  app.get("/api/auth/status", async () => {
    const hasAccounts = (await realAccounts()) > 0;
    return {
      hasAccounts,
      bypass: env.ENSEMBLE_DEV_AUTH_BYPASS,
      signup: signupMode({
        production: process.env.NODE_ENV === "production",
        allowlist: process.env.ENSEMBLE_SIGNUP_ALLOWLIST,
        hasAccounts,
      }),
    };
  });

  app.post("/api/auth/signup", async (request, reply) => {
    const body = Credentials.extend({ name: z.string().trim().max(80).default("") }).parse(request.body);
    const hasAccounts = (await realAccounts()) > 0;
    if (
      !signupPermitted({
        email: body.email,
        production: process.env.NODE_ENV === "production",
        allowlist: process.env.ENSEMBLE_SIGNUP_ALLOWLIST,
        hasAccounts,
      })
    ) {
      return reply.code(403).send({ error: INVITE_ONLY });
    }
    const taken = await prisma.user.findUnique({ where: { email: body.email } });
    if (taken?.passwordHash) {
      return reply.code(409).send({ error: "An account with that email already exists. Sign in instead." });
    }
    const first = !hasAccounts;
    const data = { email: body.email, name: body.name, passwordHash: await hashPassword(body.password), lastLoginAt: new Date() };
    // The first account claims the no-login placeholder, and with it every row made before sign-in existed.
    const user = first
      ? await prisma.user.upsert({ where: { id: env.ENSEMBLE_DEV_USER_ID }, create: { id: env.ENSEMBLE_DEV_USER_ID, ...data }, update: data })
      : await prisma.user.create({ data });
    const settings = await loadSettings(prisma, user.id);
    await saveSettings(prisma, user.id, { email: body.email, timezone: settings.timezone });
    await startSession(reply, user.id, request);
    await appendLedger({ userId: user.id, actor: "me", action: "auth.signup" });
    return { user: { id: user.id, email: user.email, name: user.name }, firstAccount: first, onboardingComplete: false };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = Credentials.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      return reply.code(401).send({ error: "Email or password is wrong." });
    }
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await startSession(reply, user.id, request);
    return { user: { id: user.id, email: user.email, name: user.name } };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    await endSession(request, reply);
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!user?.passwordHash && request.authVia !== "bypass") return reply.code(401).send({ error: "Sign in." });
    const settings = await loadSettings(prisma, request.userId);
    const pref = await prisma.preference.findFirst({ where: { userId: request.userId, key: "hub.settings", deletedAt: null } });
    return {
      user: user?.passwordHash
        ? { id: user.id, email: user.email, name: user.name }
        : { id: request.userId, email: "", name: "Local (no account)" },
      via: request.authVia,
      appearance: {
        accent: settings.appearance.accent,
        accentCustom: settings.appearance.accentCustom,
        theme: settings.appearance.theme,
        accentAt: pref?.updatedAt.getTime() ?? 0,
      },
      onboardingComplete: request.authVia === "bypass" || Boolean(user?.onboardingCompletedAt),
      modules: request.modules,
      devTools: envDevTools() || Boolean(user?.tester),
    };
  });

  app.patch("/api/auth/me", async (request) => {
    const body = z
      .object({ name: z.string().trim().max(80).optional(), password: z.string().min(8).optional(), current: z.string().optional() })
      .parse(request.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.userId } });
    if (body.password && !(await verifyPassword(body.current ?? "", user.passwordHash))) {
      throw Object.assign(new Error("Your current password is wrong."), { statusCode: 400 });
    }
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { name: body.name, ...(body.password ? { passwordHash: await hashPassword(body.password) } : {}) },
    });
    return { user: { id: updated.id, email: updated.email, name: updated.name } };
  });

  // ── personal tokens (editor hooks, Context Bridge) ────────────────────────
  //
  // Creating a `full` key uses the same session check as POST /api/connect/token.
  // Listing does not return the secret, so it cannot widen a key; a bridge key
  // never reaches it (the read-only gate refuses anything outside /api/bridge).
  // Revoke-by-id stays open to a `ens_` key. It can only end a key this user
  // already has, and it cannot mint or change a scope. There is no rescope route.

  app.get("/api/tokens", async (request) => {
    const tokens = await prisma.apiToken.findMany({
      where: { userId: request.userId, revokedAt: null, scope: { not: "device" } },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, prefix: true, scope: true, lastUsedAt: true, createdAt: true },
    });
    return { tokens };
  });

  app.post("/api/tokens", async (request) => {
    requireBrowserSession(request);
    const body = z.object({ name: z.string().trim().min(1).max(60) }).parse(request.body);
    if (request.authVia === "bypass") {
      await prisma.user.upsert({
        where: { id: request.userId },
        create: { id: request.userId, email: `${request.userId}@ensemble.local`, name: "Local (no account)" },
        update: {},
      });
    }
    const { token, hash, prefix } = newApiToken();
    const row = await prisma.apiToken.create({ data: { userId: request.userId, name: body.name, tokenHash: hash, prefix, scope: "full" } });
    await appendLedger({ userId: request.userId, actor: "me", action: "token.create", payload: { name: body.name, prefix } });
    return { id: row.id, token };
  });

  app.delete("/api/tokens/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const token = await prisma.apiToken.findFirst({ where: { id, userId: request.userId, revokedAt: null } });
    if (token?.scope === "device") {
      const device = await prisma.device.findFirst({ where: { tokenId: token.id, userId: request.userId, revokedAt: null } });
      if (device) {
        await revokePairedDevice(prisma, request.userId, device);
        return reply.code(204).send();
      }
    }
    await prisma.apiToken.updateMany({ where: { id, userId: request.userId }, data: { revokedAt: new Date() } });
    await appendLedger({ userId: request.userId, actor: "me", action: "token.revoke", payload: { id } });
    return reply.code(204).send();
  });
}
