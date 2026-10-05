/**
 * Prisma CLI does not read the repo-root .env that hub-api loads.
 * This wrapper loads it (without overriding variables already set) and then
 * runs the Prisma CLI with the remaining arguments.
 *
 *   node scripts/prisma-with-env.mjs db push
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { config } from "dotenv";
import { ensureLocalDatabase } from "./ensure-local-db.mjs";

const envFile = new URL("../../../.env", import.meta.url);
if (existsSync(envFile)) config({ path: envFile });

const database = await ensureLocalDatabase();
if (database.action === "failed") process.exit(database.status ?? 1);

const require = createRequire(import.meta.url);
const prismaEntry = require.resolve("prisma/build/index.js");
const result = spawnSync(process.execPath, [prismaEntry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
