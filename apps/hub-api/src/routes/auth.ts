import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { envDevTools } from "../lib/dev-tools.js";
import { requireBrowserSession } from "../bridge/auth.js";
import { endSession, hashPassword, newApiToken, readCookie, SESSION_COOKIE, sha256, startSession, verifyPassword } from "../lib/auth.js";
import { currentSignupPolicy, INVITE_ONLY, signupMode, signupPermitted } from "../lib/signup.js";
import { emailConfigured, requireEmailConfigured, sendAccountEmail, verifyCodeTokenId } from "../lib/auth-email.js";
import { LoginProvider, loginProviderConfigured } from "../lib/auth-oauth.js";
import { turnstileSiteKey, verifyTurnstile } from "../lib/turnstile.js";
import { deleteAccountData, exportAccountData } from "../lib/account-data.js";
import { revokePairedDevice } from "../devices/revoke.js";
import { appendLedger } from "../lib/ledger.js";
import { loadSettings, saveSettings } from "../lib/settings.js";

const Credentials = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  password: z.string().min(8, "Use at least 8 characters.").max(256, "Use at most 256 characters."),
});
const VerifyCode = z.object({ code: z.string().min(1).max(16) });
const OptionalProfileText = (max: number) => z.preprocess((value) => (value === null ? undefined : value), z.string().trim().max(max).optional());
const Profile = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(80),
  gender: OptionalProfileText(40),
  profession: OptionalProfileText(80),
  organization: OptionalProfileText(80),
  heardFrom: OptionalProfileText(120),
});

function optionalText(value: string | null | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

function normalizeVerifyCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]+/g, "");
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  const realAccounts = () => prisma.user.count({ where: { OR: [{ passwordHash: { not: null } }, { authIdentities: { some: {} } }] } });
  const profileView = (user: { gender: string | null; profession: string | null; organization: string | null; heardFrom: string | null }) => ({
    gender: user.gender,
    profession: user.profession,
    organization: user.organization,
    heardFrom: user.heardFrom,
  });
  const userView = (user: {
    id: string;
    email: string;
    name: string;
    emailVerifiedAt: Date | null;
    passwordHash: string | null;
    gender: string | null;
    profession: string | null;
    organization: string | null;
    heardFrom: string | null;
  }) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: Boolean(user.emailVerifiedAt),
    hasPassword: Boolean(user.passwordHash),
    profile: profileView(user),
  });
  const Token = z.object({ token: z.string().min(20).max(200) });
  const sensitiveSession = async (request: import("fastify").FastifyRequest, current?: string) => {
    requireBrowserSession(request);
    if (request.authVia !== "session") throw Object.assign(new Error("Sign in with a browser account first."), { statusCode: 403 });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.userId } });
    if (user.passwordHash && current !== undefined) {
      if (!(await verifyPassword(current, user.passwordHash))) throw Object.assign(new Error("Your current password is wrong."), { statusCode: 400 });
    } else {
      const session = await prisma.session.findUnique({ where: { id: sha256(readCookie(request, SESSION_COOKIE) ?? "") } });
      if (!session || session.createdAt < new Date(Date.now() - 10 * 60_000)) {
        throw Object.assign(new Error("Sign in again before changing login methods or deleting your account."), { statusCode: 403 });
      }
    }
    return user;
  };

  app.get("/api/auth/status", async () => {
    const hasAccounts = (await realAccounts()) > 0;
    return {
      hasAccounts,
      bypass: env.ENSEMBLE_DEV_AUTH_BYPASS,
      signup: signupMode(currentSignupPolicy()),
      providers: LoginProvider.options.filter(loginProviderConfigured),
      emailConfigured: emailConfigured(),
      turnstileSiteKey: turnstileSiteKey(),
    };
  });

  app.post("/api/auth/signup", async (request, reply) => {
    const body = Credentials.extend({ name: z.string().trim().max(80).default(""), turnstileToken: z.string().max(2048).optional() }).parse(request.body);
    const hasAccounts = (await realAccounts()) > 0;
    if (
      !signupPermitted({
        email: body.email,
        ...currentSignupPolicy(),
      })
    ) {
      return reply.code(403).send({ error: INVITE_ONLY });
    }
    await verifyTurnstile(body.turnstileToken, request.ip);
    const hosted = process.env.NODE_ENV === "production" && process.env.ENSEMBLE_DESKTOP !== "1";
    if (hosted) requireEmailConfigured();
    const first = !hasAccounts && !hosted;
    const taken = await prisma.user.findUnique({ where: { email: body.email }, include: { authIdentities: { select: { id: true } } } });
    if (taken && (taken.passwordHash || taken.authIdentities.length || !first || taken.id !== env.ENSEMBLE_DEV_USER_ID)) {
      return reply.code(409).send({ error: "An account with that email already exists. Sign in instead." });
    }
    const data = { email: body.email, name: body.name, passwordHash: await hashPassword(body.password), lastLoginAt: new Date(), emailVerifiedAt: null };
    const user = await prisma.$transaction(async (tx) => {
      if (!first) return tx.user.create({ data });
      const placeholder = await tx.user.findUnique({ where: { id: env.ENSEMBLE_DEV_USER_ID }, include: { authIdentities: { select: { id: true } } } });
      if (placeholder?.passwordHash || placeholder?.authIdentities.length) return tx.user.create({ data });
      if (!placeholder) return tx.user.create({ data: { id: env.ENSEMBLE_DEV_USER_ID, ...data } });
      const claimed = await tx.user.updateMany({
        where: { id: placeholder.id, passwordHash: null, authIdentities: { none: {} } }, data,
      });
      return claimed.count === 1 ? tx.user.findUniqueOrThrow({ where: { id: placeholder.id } }) : tx.user.create({ data });
    }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw Object.assign(new Error("An account with that email already exists. Sign in instead."), { statusCode: 409 });
      }
      throw error;
    });
    const settings = await loadSettings(prisma, user.id);
    await saveSettings(prisma, user.id, { email: body.email, timezone: settings.timezone });
    await startSession(reply, user.id, request);
    await appendLedger({ userId: user.id, actor: "me", action: "auth.signup" });
    if (emailConfigured()) {
      try {
        await sendAccountEmail(prisma, user, "verify");
      } catch (cause) {
        throw Object.assign(new Error("Your account was created, but the verification email could not be sent. Sign in and use Resend verification, or contact the operator.", { cause }), {
          statusCode: 503, code: "EMAIL_DELIVERY_FAILED",
        });
      }
    }
    return { user: userView(user), firstAccount: first, onboardingComplete: false, verificationRequired: hosted, verificationSent: emailConfigured() };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = Credentials.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      return reply.code(401).send({ error: "Email or password is wrong." });
    }
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await startSession(reply, user.id, request);
    return { user: userView(user) };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    await endSession(request, reply);
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!user && request.authVia !== "bypass") return reply.code(401).send({ error: "Sign in." });
    const settings = await loadSettings(prisma, request.userId);
    const pref = await prisma.preference.findFirst({ where: { userId: request.userId, key: "hub.settings", deletedAt: null } });
    return {
      user: user && request.authVia !== "bypass" && request.authVia !== "desktop"
        ? userView(user)
        : { id: request.userId, email: "", name: "Local (no account)", emailVerified: true, hasPassword: false, profile: { gender: null, profession: null, organization: null, heardFrom: null } },
      via: request.authVia,
      verificationRequired: process.env.NODE_ENV === "production" && process.env.ENSEMBLE_DESKTOP !== "1" && !user?.emailVerifiedAt,
      profileComplete: request.authVia === "bypass" || process.env.ENSEMBLE_DESKTOP === "1" || Boolean(user?.profileCompletedAt),
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

  app.patch("/api/auth/me", async (request, reply) => {
    const body = z
      .object({ name: z.string().trim().max(80).optional(), password: Credentials.shape.password.optional(), current: z.string().max(256).optional() })
      .parse(request.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.userId } });
    if (body.password) {
      await sensitiveSession(request, user.passwordHash ? body.current ?? "" : undefined);
      if (!user.emailVerifiedAt && process.env.NODE_ENV === "production") {
        throw Object.assign(new Error("Verify your email before adding or changing a password."), { statusCode: 403 });
      }
    }
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { name: body.name, ...(body.password ? { passwordHash: await hashPassword(body.password) } : {}) },
    });
    if (body.password) {
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await startSession(reply, user.id, request);
      await appendLedger({ userId: user.id, actor: "me", action: "auth.password" });
    }
    return { user: userView(updated) };
  });

  app.put("/api/auth/profile", async (request) => {
    requireBrowserSession(request);
    const body = Profile.parse(request.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.userId } });
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        name: body.name,
        gender: optionalText(body.gender),
        profession: optionalText(body.profession),
        organization: optionalText(body.organization),
        heardFrom: optionalText(body.heardFrom),
        profileCompletedAt: user.profileCompletedAt ?? new Date(),
      },
    });
    await appendLedger({ userId: updated.id, actor: "me", action: "auth.profile" });
    return { user: userView(updated), profile: profileView(updated) };
  });

  app.post("/api/auth/verify-email", async (request) => {
    const { code: rawCode } = VerifyCode.parse(request.body);
    if (request.authVia !== "session") {
      throw Object.assign(new Error("Sign in to the account you are verifying, then enter the code."), { statusCode: 401 });
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.userId } });
    if (user.emailVerifiedAt) return { verified: true };
    const code = normalizeVerifyCode(rawCode);
    const row = await prisma.emailToken.findFirst({
      where: { userId: user.id, kind: "verify", expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (!row) throw Object.assign(new Error("There is no active code. Send a new one."), { statusCode: 400 });
    // Reserve the attempt before comparing, so parallel requests cannot try more than five codes.
    const reserved = await prisma.emailToken.updateMany({
      where: { id: row.id, attempts: { lt: 5 } },
      data: { attempts: { increment: 1 } },
    });
    if (reserved.count !== 1) {
      await prisma.emailToken.deleteMany({ where: { id: row.id, userId: user.id, kind: "verify" } });
      throw Object.assign(new Error("Too many wrong codes. Send a new code."), { statusCode: 400 });
    }
    if (row.id !== verifyCodeTokenId(user.id, code)) {
      const current = await prisma.emailToken.findUnique({ where: { id: row.id }, select: { attempts: true } });
      const used = current?.attempts ?? 5;
      if (used >= 5) {
        await prisma.emailToken.deleteMany({ where: { id: row.id, userId: user.id, kind: "verify" } });
        throw Object.assign(new Error("Too many wrong codes. Send a new code."), { statusCode: 400 });
      }
      throw Object.assign(new Error(`That code is not right. ${5 - used} tries left.`), { statusCode: 400 });
    }
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
      await tx.emailToken.deleteMany({ where: { userId: user.id, kind: "verify" } });
    });
    await appendLedger({ userId: user.id, actor: "me", action: "auth.verify" });
    return { verified: true };
  });

  app.post("/api/auth/resend-verification", async (request) => {
    requireBrowserSession(request);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.userId } });
    if (!user.emailVerifiedAt) await sendAccountEmail(prisma, user, "verify");
    return { sent: !user.emailVerifiedAt };
  });

  app.post("/api/auth/forgot", async (request) => {
    const { email } = Credentials.pick({ email: true }).parse(request.body);
    requireEmailConfigured();
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) await sendAccountEmail(prisma, user, "reset");
    return { message: "If an account exists, a reset link has been sent. Check your inbox." };
  });

  app.post("/api/auth/reset", async (request) => {
    const { token, password } = Token.extend({ password: Credentials.shape.password }).parse(request.body);
    const passwordHash = await hashPassword(password);
    await prisma.$transaction(async (tx) => {
      const row = await tx.emailToken.findFirst({ where: { id: sha256(token), kind: "reset", expiresAt: { gt: new Date() } } });
      if (!row) throw Object.assign(new Error("This reset link is invalid or expired. Request a new link."), { statusCode: 400 });
      const previous = await tx.user.update({ where: { id: row.userId }, data: { id: row.userId } });
      // Recovering an unverified address must not retain identities attached
      // before the email owner proved ownership.
      if (!previous.emailVerifiedAt) await tx.authIdentity.deleteMany({ where: { userId: row.userId } });
      await tx.user.update({ where: { id: row.userId }, data: { passwordHash, emailVerifiedAt: new Date() } });
      const consumed = await tx.emailToken.deleteMany({ where: { id: row.id } });
      if (consumed.count !== 1) throw Object.assign(new Error("This reset link has already been used."), { statusCode: 400 });
      await tx.session.deleteMany({ where: { userId: row.userId } });
      await tx.emailToken.deleteMany({ where: { userId: row.userId } });
    });
    return { reset: true };
  });

  app.get("/api/auth/identities", async (request) => {
    requireBrowserSession(request);
    const identities = await prisma.authIdentity.findMany({
      where: { userId: request.userId }, select: { provider: true, email: true, createdAt: true },
    });
    return { identities, providers: LoginProvider.options.filter(loginProviderConfigured) };
  });

  app.delete("/api/auth/identities/:provider", async (request, reply) => {
    const { provider } = z.object({ provider: LoginProvider }).parse(request.params);
    const { current } = z.object({ current: z.string().max(256).optional() }).parse(request.body ?? {});
    await sensitiveSession(request, current);
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.update({ where: { id: request.userId }, data: { id: request.userId } });
      const count = await tx.authIdentity.count({ where: { userId: user.id } });
      if (!user.passwordHash && count <= 1) throw Object.assign(new Error("Add a password or another provider before removing your last login method."), { statusCode: 400 });
      await tx.authIdentity.deleteMany({ where: { userId: user.id, provider } });
    });
    await appendLedger({ userId: request.userId, actor: "me", action: "auth.unlink", payload: { provider } });
    return reply.code(204).send();
  });

  app.get("/api/auth/export", async (request, reply) => {
    requireBrowserSession(request);
    reply.header("Content-Disposition", 'attachment; filename="ensemble-data.json"');
    reply.header("Cache-Control", "no-store");
    return exportAccountData(prisma, request.userId);
  });

  app.delete("/api/auth/account", async (request, reply) => {
    const body = z.object({ confirmation: z.literal("DELETE"), current: z.string().max(256).optional() }).parse(request.body);
    await sensitiveSession(request, body.current);
    const active = await prisma.workspaceJob.count({ where: { userId: request.userId, status: { in: ["running", "claimed", "stopping", "waiting_approval"] } } });
    if (active) throw Object.assign(new Error("Stop your active agent runs before deleting your account."), { statusCode: 409 });
    const devices = await prisma.device.findMany({ where: { userId: request.userId, revokedAt: null } });
    for (const device of devices) await revokePairedDevice(prisma, request.userId, device);
    await deleteAccountData(prisma, request.userId);
    await endSession(request, reply);
    return reply.code(204).send();
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
