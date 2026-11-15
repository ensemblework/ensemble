/**
 * The Prisma driver adapter for the desktop's PGlite database.
 *
 * pglite-prisma-adapter 0.6 is written for Prisma's Rust query engine, which converts values and names
 * database errors itself. Prisma's Rust-free client (`engineType = "client"`, which the Windows arm64
 * sidecar carries because Prisma builds no native query engine for that processor) leaves both to the
 * adapter: it sends bytes as base64 text, reads a timestamp without an offset as local time, and turns
 * only named adapter errors into P2002, P2003 and the rest. For that client the adapter is wrapped to
 * do those three things. The Rust engine gets the adapter unchanged.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { PrismaPGlite } from "pglite-prisma-adapter";

type ArgType = { scalarType?: string; arity?: string } | undefined;
type SqlQuery = { sql: string; args: unknown[]; argTypes?: ArgType[] };
type ResultSet = { columnNames: string[]; columnTypes: number[]; rows: unknown[][] };
type PostgresCause = { kind: string; code?: string; message?: string; detail?: string; column?: string };

// ColumnTypeEnum in @prisma/driver-adapter-utils.
const DATE_TIME = 10;
const DATE_TIME_ARRAY = 74;

let rustFree: boolean | undefined;

/** Whether `prisma generate` made the Rust-free client: its copy of the schema has `engineType = "client"`. */
export function generatedRustFreeClient(): boolean {
  if (rustFree === undefined) {
    const require = createRequire(import.meta.url);
    const generated = createRequire(require.resolve("@prisma/client")).resolve(".prisma/client/package.json");
    rustFree = /^\s*engineType\s*=\s*"client"\s*$/m.test(readFileSync(join(dirname(generated), "schema.prisma"), "utf8"));
  }
  return rustFree;
}

/** The adapter factory for one open PGlite database. */
export function pgliteAdapter(db: PGlite, options: { rustFree: boolean }): PrismaPGlite {
  const factory = new PrismaPGlite(db);
  if (!options.rustFree) return factory;
  return new Proxy(factory, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key === "connect") return async () => forRustFreeClient(await target.connect());
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** An adapter (or one of its transactions) that converts values and names errors for the Rust-free client. */
function forRustFreeClient<T extends object>(queryable: T): T {
  return new Proxy(queryable, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      if (key === "queryRaw") return async (query: SqlQuery) => withUtcTimes((await named(() => value.call(target, withBinary(query)))) as ResultSet);
      if (key === "executeRaw") return (query: SqlQuery) => named(() => value.call(target, withBinary(query)));
      if (key === "startTransaction") return async (...args: unknown[]) => forRustFreeClient((await named(() => value.apply(target, args))) as object);
      return value.bind(target);
    },
  });
}

/** The client sends Bytes as base64 text; PGlite binds only binary values to bytea. */
export function withBinary(query: SqlQuery): SqlQuery {
  const types = query.argTypes ?? [];
  if (!types.some((type) => type?.scalarType === "bytes")) return query;
  return { ...query, args: query.args.map((arg, index) => binary(arg, types[index])) };
}

function binary(arg: unknown, type: ArgType): unknown {
  if (type?.scalarType !== "bytes") return arg;
  if (Array.isArray(arg)) return arg.map((item) => binary(item, type));
  return typeof arg === "string" ? Buffer.from(arg, "base64") : arg;
}

/**
 * Timestamps are stored as UTC and the adapter returns them without an offset. The client parses a raw
 * query's timestamps with `new Date`, which reads a value without an offset as local time, so each one is
 * given its UTC offset.
 */
export function withUtcTimes(result: ResultSet): ResultSet {
  const columns = result.columnTypes.flatMap((type, index) => (type === DATE_TIME || type === DATE_TIME_ARRAY ? [index] : []));
  if (!columns.length) return result;
  for (const row of result.rows) for (const index of columns) row[index] = utc(row[index]);
  return result;
}

function utc(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(utc);
  if (typeof value !== "string" || /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value)) return value;
  return `${value.replace(" ", "T")}+00:00`;
}

async function named<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw nameDatabaseError(error);
  }
}

/**
 * The client gives a Prisma code only to errors it knows by kind; a plain `postgres` error reaches the
 * caller as it is. These are the kinds the Rust engine read from the same SQLSTATE codes.
 */
export function nameDatabaseError(error: unknown): unknown {
  const cause = (error as { name?: string; cause?: PostgresCause } | null)?.cause;
  if ((error as { name?: string } | null)?.name !== "DriverAdapterError" || cause?.kind !== "postgres") return error;
  (error as { cause: unknown }).cause = { ...kindOf(cause), originalCode: cause.code, originalMessage: cause.message };
  return error;
}

function kindOf(cause: PostgresCause): Record<string, unknown> {
  const fields = cause.detail?.match(/Key \(([^)]+)\)/)?.[1]?.split(", ");
  switch (cause.code) {
    case "22001":
      return { kind: "LengthMismatch", column: cause.column };
    case "22003":
      return { kind: "ValueOutOfRange", cause: cause.message };
    case "23502":
      return { kind: "NullConstraintViolation", constraint: cause.column ? { fields: [cause.column] } : fields ? { fields } : undefined };
    case "23503": {
      const index = cause.message?.match(/foreign key constraint "([^"]+)"/)?.[1];
      return { kind: "ForeignKeyConstraintViolation", constraint: cause.column ? { fields: [cause.column] } : index ? { index } : undefined };
    }
    case "23505":
      return { kind: "UniqueConstraintViolation", constraint: fields ? { fields } : undefined };
    case "40001":
    case "40P01":
      return { kind: "TransactionWriteConflict" };
    case "42P01":
      return { kind: "TableDoesNotExist", table: cause.message?.match(/relation "([^"]+)"/)?.[1] };
    case "42703":
      return { kind: "ColumnNotFound", column: cause.message?.match(/column "([^"]+)"/)?.[1] };
    default:
      return { ...cause };
  }
}
