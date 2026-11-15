import type { PrismaClient } from "@prisma/client";

/** Set before hub-api imports `prisma`, so the desktop process uses PGlite. */
type Adapter = NonNullable<NonNullable<ConstructorParameters<typeof PrismaClient>[0]>["adapter"]>;

let adapter: Adapter | undefined;

export function setDesktopAdapter(value: Adapter | undefined): void {
  adapter = value;
}

export function desktopAdapter(): Adapter | undefined {
  return adapter;
}

/**
 * For a client built before the desktop database opens. Prisma's Rust-free client cannot be built
 * without an adapter; with this one it is built, and its queries fail, as the Rust engine's would.
 */
export const closedDatabase = {
  provider: "postgres",
  adapterName: "ensemble-closed-database",
  connect: () => Promise.reject(new Error("The local database is not open yet.")),
} as unknown as Adapter;
