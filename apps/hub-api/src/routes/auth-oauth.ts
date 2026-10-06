import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { env } from "../config.js";
import { requireBrowserSession } from "../bridge/auth.js";
import { appendCookie, readCookie, SESSION_COOKIE, sha256, startSession } from "../lib/auth.js";
import { authWebOrigin, emailConfigured, sendAccountEmail } from "../lib/auth-email.js";
import { exchangeLoginCode, LoginProvider, loginAuthorizationUrl, newOAuthFlow, type LoginProfile } from "../lib/auth-oauth.js";
import { sessionCookieHeader, sessionCookieSecure } from "../lib/cookie.js";
import { currentSignupPolicy, INVITE_ONLY, signupPermitted } from "../lib/signup.js";
import { appendLedger } from "../lib/ledger.js";

const FLOW_COOKIE = "ensemble_login_flow";
const FLOW_SECONDS = 600;

function flowCookie(state: string): string {
  const signature = createHmac("sha256", env.ENSEMBLE_INTERNAL_TOKEN).update(state).digest("base64url");
  return `${state}.${signature}`;
}

function matchesCookie(state: string, cookie: string | null): boolean {
  if (!cookie) return false;
  const expected = Buffer.from(flowCookie(state));
  const actual = Buffer.from(cookie);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function setFlowCookie(reply: FastifyReply, request: FastifyRequest, state: string, age: number): void {
  appendCookie(reply, sessionCookieHeader(FLOW_COOKIE, state ? flowCookie(state) : "", age, sessionCookieSecure({
    nodeEnv: process.env.NODE_ENV, protocol: request.protocol, forwardedProto: request.headers["x-forwarded-proto"],
  })));
}

type CodeExchange = typeof exchangeLoginCode;

export async function authOAuthRoutes(app: FastifyInstance, options: { exchange?: CodeExchange } = {}): Promise<void> {
  const { prisma } = app;
  const exchange = options.exchange ?? exchangeLoginCode;

  app.get("/api/auth/oauth/:provider/start", async (request, reply) => {
    const { provider } = z.object({ provider: LoginProvider }).parse(request.params);
    const { link } = z.object({ link: z.enum(["1"]).optional() }).parse(request.query);
    let sessionId: string | null = null;
    if (link) {
      requireBrowserSession(request);
      if (request.authVia !== "session") throw Object.assign(new Error("Sign in with a browser account before linking a provider."), { statusCode: 403 });
      const cookie = readCookie(request, SESSION_COOKIE);
      if (!cookie) throw Object.assign(new Error("Sign in again before linking a provider."), { statusCode: 401 });
      sessionId = sha256(cookie);
      const session = await prisma.session.findFirst({ where: { id: sessionId, userId: request.userId, expiresAt: { gt: new Date() } } });
      if (!session || session.createdAt < new Date(Date.now() - 10 * 60_000)) {
        throw Object.assign(new Error("Sign in again before linking a provider."), { statusCode: 403 });
      }
    }
    const flow = newOAuthFlow();
    const url = loginAuthorizationUrl(provider, flow);
    await prisma.authFlow.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    await prisma.authFlow.create({
      data: {
        id: sha256(flow.state), provider, codeVerifier: flow.verifier, nonce: flow.nonce,
        userId: link ? request.userId : null, sessionId, expiresAt: new Date(Date.now() + FLOW_SECONDS * 1000),
      },
    });
    setFlowCookie(reply, request, flow.state, FLOW_SECONDS);
    reply.header("Cache-Control", "no-store");
    return reply.redirect(url);
  });

  app.get("/api/auth/oauth/:provider/callback", async (request, reply) => {
    const destination = new URL("/login", authWebOrigin());
    reply.header("Cache-Control", "no-store");
    setFlowCookie(reply, request, "", 0);
    try {
      const { provider } = z.object({ provider: LoginProvider }).parse(request.params);
      const query = z.object({ state: z.string().min(20).max(200), code: z.string().max(4096).optional(), error: z.string().max(200).optional() }).parse(request.query);
      if (!matchesCookie(query.state, readCookie(request, FLOW_COOKIE))) {
        throw Object.assign(new Error("Sign-in expired or did not start in this browser. Try again."), { statusCode: 400 });
      }
      const flow = await prisma.$transaction(async (tx) => {
        const row = await tx.authFlow.findUnique({ where: { id: sha256(query.state) } });
        if (!row || row.expiresAt <= new Date() || row.provider !== provider) {
          throw Object.assign(new Error("Sign-in expired. Try again."), { statusCode: 400 });
        }
        const consumed = await tx.authFlow.deleteMany({ where: { id: row.id } });
        if (consumed.count !== 1) throw Object.assign(new Error("This sign-in link has already been used."), { statusCode: 400 });
        return row;
      });
      if (query.error || !query.code) throw Object.assign(new Error("Provider sign-in was cancelled or denied."), { statusCode: 400 });
      if (flow.userId) {
        destination.pathname = "/settings";
        const session = await prisma.session.findFirst({ where: { id: flow.sessionId ?? "", userId: flow.userId, expiresAt: { gt: new Date() } } });
        if (!session || sha256(readCookie(request, SESSION_COOKIE) ?? "") !== flow.sessionId) {
          throw Object.assign(new Error("Sign in again before linking a provider."), { statusCode: 401 });
        }
      }
      const profile: LoginProfile = await exchange(provider, query.code, flow.codeVerifier, flow.nonce);
      let created = false;
      const user = await prisma.$transaction(async (tx) => {
        const identity = await tx.authIdentity.findUnique({ where: { provider_subject: { provider, subject: profile.subject } }, include: { user: true } });
        if (flow.userId) {
          if (identity && identity.userId !== flow.userId) throw Object.assign(new Error("That provider account is already linked to a different Ensemble account."), { statusCode: 409 });
          const owner = await tx.user.findUniqueOrThrow({ where: { id: flow.userId } });
          await tx.authIdentity.upsert({
            where: { userId_provider: { userId: owner.id, provider } },
            create: { userId: owner.id, provider, subject: profile.subject, email: profile.email },
            update: { subject: profile.subject, email: profile.email },
          });
          if (profile.verified && profile.email === owner.email && !owner.emailVerifiedAt) {
            return tx.user.update({ where: { id: owner.id }, data: { emailVerifiedAt: new Date() } });
          }
          return owner;
        }
        if (identity) return identity.user;
        if (!profile.email) throw Object.assign(new Error("The provider did not supply an email. Sign up with email, then link this provider in Account settings."), { statusCode: 400 });
        let account = await tx.user.findUnique({ where: { email: profile.email } });
        if (account) {
          if (!profile.verified || !account.emailVerifiedAt) {
            throw Object.assign(new Error("An account with this email already exists. Sign in using its existing method, then link this provider in Account settings."), { statusCode: 409 });
          }
          const other = await tx.authIdentity.findUnique({ where: { userId_provider: { userId: account.id, provider } } });
          if (other) throw Object.assign(new Error("A different account from this provider is already linked. Use your existing sign-in method."), { statusCode: 409 });
        } else {
          if (!signupPermitted({ ...currentSignupPolicy(), email: profile.email })) {
            throw Object.assign(new Error(INVITE_ONLY), { statusCode: 403 });
          }
          if (!profile.verified && process.env.NODE_ENV === "production" && !emailConfigured()) {
            throw Object.assign(new Error("Email verification is not configured. Use Google or GitHub, or contact the operator."), { statusCode: 503 });
          }
          account = await tx.user.create({ data: { email: profile.email, name: profile.name, emailVerifiedAt: profile.verified ? new Date() : null } });
          created = true;
        }
        await tx.authIdentity.create({ data: { userId: account.id, provider, subject: profile.subject, email: profile.email } });
        return account;
      });
      if (created && !user.emailVerifiedAt && emailConfigured()) await sendAccountEmail(prisma, user, "verify");
      await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      if (!flow.userId) await startSession(reply, user.id, request);
      await appendLedger({ userId: user.id, actor: "me", action: flow.userId ? "auth.link" : "auth.oauth", payload: { provider } });
      destination.pathname = flow.userId ? "/settings" : user.onboardingCompletedAt ? "/today" : "/start";
      destination.search = flow.userId ? "?linked=1" : "";
      return reply.redirect(destination.toString());
    } catch (error) {
      const status = error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
      const duplicate = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
      const message = duplicate ? "This email or provider is already linked. Sign in and manage providers in Account settings."
        : error instanceof Error && status < 500 ? error.message : "Sign-in could not be completed. Try again or contact the operator.";
      // Provider/JWT errors can include tokens. Log classification, never their bodies.
      request.log.warn({ provider: z.object({ provider: z.string() }).safeParse(request.params).data?.provider, status }, "provider sign-in failed");
      destination.search = new URLSearchParams({ error: message }).toString();
      return reply.redirect(destination.toString());
    }
  });
}
