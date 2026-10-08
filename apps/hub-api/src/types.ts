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
    /**
     * Who signed in. Unset or equal to userId outside a space. Read it with `accountIdOf(request)`
     * (lib/auth.ts), never directly: test apps and service calls only set userId.
     */
    accountId?: string;
    /** Owner, member of the space, or one shared item. Unset for tokens and service calls (owner). */
    access?: import("./sharing/context.js").Access;
    authVia: import("./lib/auth.js").AuthVia;
    tokenScope?: import("./lib/auth.js").TokenScope;
    /** Set when the caller presented a personal `ens_` token. */
    tokenId?: string;
    /** Null means no optional modules. */
    modules: string | null;
  }
}

export {};

