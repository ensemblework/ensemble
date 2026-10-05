import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, zipSync } from "fflate";
import type { PlotColumn } from "@ensemble/shared-types";
import { cachedTable, forgetTable, hashBytes, rememberTable } from "./cache.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.ensemble/plots");

export type StoredTable = {
  columns: PlotColumn[];
  rows: Array<Array<string | number | null>>;
};

function dir(userId: string): string {
  const path = resolve(ROOT, userId);
  mkdirSync(path, { recursive: true });
  return path;
}

function tablePath(userId: string, id: string): string {
  return resolve(dir(userId), `${id}.json.gz`);
}

function binPath(userId: string, id: string): string {
  return resolve(dir(userId), `${id}.bin`);
}

export function writeTable(userId: string, id: string, table: StoredTable, original?: Uint8Array): string {
  const json = JSON.stringify(table);
  const zipped = zipSync({ "table.json": new TextEncoder().encode(json) });
  writeFileSync(tablePath(userId, id), zipped);
  if (original) writeFileSync(binPath(userId, id), original);
  const hash = hashBytes(json);
  rememberTable(id, hash, table.rows);
  return hash;
}

export function readTable(userId: string, id: string, hash: string): StoredTable {
  const hit = cachedTable(id, hash);
  const path = tablePath(userId, id);
  if (!existsSync(path)) throw Object.assign(new Error("That dataset is missing its table."), { statusCode: 404 });
  const unzipped = unzipSync(readFileSync(path));
  const json = new TextDecoder().decode(unzipped["table.json"]);
  const table = JSON.parse(json) as StoredTable;
  if (hit) return { columns: table.columns, rows: hit };
  rememberTable(id, hash, table.rows);
  return table;
}

export function readOriginal(userId: string, id: string): Buffer | null {
  const path = binPath(userId, id);
  if (!existsSync(path)) return null;
  return readFileSync(path);
}

export function removeDatasetFiles(userId: string, id: string): void {
  forgetTable(id);
  rmSync(tablePath(userId, id), { force: true });
  rmSync(binPath(userId, id), { force: true });
}
