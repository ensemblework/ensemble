import { randomUUID } from "node:crypto";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { BuildAppOptions } from "../app.js";
import { OPTIONAL_MODULES, serializeModules } from "@ensemble/shared-types";

export const HTTP_TEST_PASSWORD = "test-password-only-123";

export type HttpUser = {
  id: string;
  email: string;
  cookie: string;
  inject: (options: InjectOptions) => Promise<LightMyRequestResponse>;
};

let booted = false;

export async function createHttpHarness(options: BuildAppOptions = {}) {
  if (booted) throw new Error("Create one HTTP harness per test file; the production database client is process-scoped.");
  booted = true;
  process.env.ENSEMBLE_DEV_AUTH_BYPASS = "false";
  process.env.ENSEMBLE_DESKTOP = "0";
  delete process.env.ENSEMBLE_DESKTOP_TOKEN;
  process.env.REDIS_URL = "memory://http-tests";
  process.env.ENSEMBLE_INTERNAL_TOKEN = "http-test-internal-token-not-for-production";
  process.env.ENSEMBLE_LOG_LEVEL = "silent";
  for (const bucket of ["LOGIN", "SIGNUP", "EMAIL", "MODEL", "TOKEN", "DEVICE", "CLI_START", "CLI_TOKEN", "MCP", "LINK_READ", "LINK_WRITE"]) {
    process.env[`ENSEMBLE_RATE_${bucket}_LIMIT`] = "0";
  }

  const testDatabase = process.env.ENSEMBLE_TEST_DATABASE_URL;
  let closeDatabase = async () => {};
  let db: PrismaClient | undefined;
  const users: string[] = [];
  try {
    if (testDatabase) {
      const url = new URL(testDatabase);
      if (!["postgres:", "postgresql:"].includes(url.protocol) || !/test/i.test(url.pathname)) {
        throw new Error("ENSEMBLE_TEST_DATABASE_URL must name a dedicated PostgreSQL test database (database name must contain 'test'). Never point this suite at real data.");
      }
      process.env.DATABASE_URL = testDatabase;
    } else {
      process.env.DATABASE_URL = "postgresql://http_test:http_test@127.0.0.1:1/ensemble_http_test";
      const { openMemoryDatabase, closeDesktopDatabase } = await import("../lib/pglite-engine.js");
      closeDatabase = closeDesktopDatabase;
      await openMemoryDatabase();
    }
    const { buildApp } = await import("../app.js");
    const { prisma } = await import("../lib/prisma.js");
    db = prisma;
    await prisma.$queryRaw`SELECT 1`;
    const app = await buildApp({ logger: false, ...options });
    await app.ready();
    const { sha256, SESSION_COOKIE, hashPassword, newApiToken } = await import("../lib/auth.js");
    const passwordHash = await hashPassword(HTTP_TEST_PASSWORD);

    async function asUser(email = `http-${randomUUID()}@example.test`): Promise<HttpUser> {
      const user = await prisma.user.create({ data: { email, name: "HTTP test user", passwordHash, moduleSet: serializeModules(OPTIONAL_MODULES) } });
      users.push(user.id);
      const session = randomUUID();
      await prisma.session.create({
        data: { id: sha256(session), userId: user.id, expiresAt: new Date(Date.now() + 86_400_000), modules: user.moduleSet },
      });
      const cookie = `${SESSION_COOKIE}=${session}`;
      return {
        id: user.id,
        email,
        cookie,
        inject: (request) => app.inject({ ...request, headers: { ...request.headers, cookie } }),
      };
    }

    async function asToken(user: HttpUser, scope: "full" | "device" | "bridge") {
      const token = newApiToken();
      const row = await prisma.apiToken.create({
        data: { userId: user.id, name: `HTTP ${scope} test`, scope, tokenHash: token.hash, prefix: token.prefix },
      });
      return {
        id: row.id,
        token: token.token,
        inject: (request: InjectOptions) => app.inject({ ...request, headers: { ...request.headers, authorization: `Bearer ${token.token}` } }),
      };
    }

    return {
      app,
      prisma,
      asUser,
      asToken,
      internal: (user: HttpUser, request: InjectOptions) => app.inject({
        ...request,
        headers: { ...request.headers, "x-ensemble-internal": process.env.ENSEMBLE_INTERNAL_TOKEN!, "x-ensemble-user": user.id },
      }),
      close: async () => {
        await app.close();
        if (testDatabase) {
          const { deleteAccountData } = await import("../lib/account-data.js");
          for (const userId of users) {
            if (await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })) {
              await deleteAccountData(prisma, userId);
            }
          }
        }
        await prisma.$disconnect();
        await closeDatabase();
        const { eraseUserDatasetFiles } = await import("../plots/store.js");
        for (const userId of users) eraseUserDatasetFiles(userId);
      },
    };
  } catch (error) {
    if (db) await db.$disconnect();
    await closeDatabase();
    throw new Error("HTTP harness could not start. It requires the checked-in PGlite migrations or a migrated dedicated ENSEMBLE_TEST_DATABASE_URL; critical tests are not skipped.", { cause: error });
  }
}

export type HttpHarness = Awaited<ReturnType<typeof createHttpHarness>>;
