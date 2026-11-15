import { PrismaClient } from "@prisma/client";
import { closedDatabase, desktopAdapter } from "./desktop-db.js";

const adapter = desktopAdapter();
export const prisma = adapter ? new PrismaClient({ adapter }) : withoutAdapter();

/** Hosted: Prisma's own Postgres driver. Only the Rust-free client (P2038) refuses to be built without an adapter. */
function withoutAdapter(): PrismaClient {
  try {
    return new PrismaClient();
  } catch (error) {
    if ((error as { errorCode?: string }).errorCode !== "P2038") throw error;
    return new PrismaClient({ adapter: closedDatabase });
  }
}
