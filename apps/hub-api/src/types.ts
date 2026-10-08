import type { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
    redis: Redis;
  }
  interface FastifyRequest {
    /** Whose data: the active Ensemble space. */
    userId: string;
    /** Who signed in. Equal to userId outside a space. Account routes (password, email, delete) use this. */
    accountId: string;
    authVia: import("./lib/auth.js").AuthVia;
    tokenScope?: import("./lib/auth.js").TokenScope;
    /** Set when the caller presented a personal `ens_` token. */
    tokenId?: string;
    /** Null means no optional modules. */
    modules: string | null;
  }
}

export {};

