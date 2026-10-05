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
