import { open, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { git, GitError } from "../lib/git.js";
import { GuardError, jailPath } from "../workspace/guard.js";

export class RepoReadError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "RepoReadError";
  }
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "target",
  "vendor",
  "__pycache__",
  ".turbo",
  "out",
  ".cache",
]);

const MAX_LIST = 8_000;
const TREE_CAP = 200;
const TREE_DEPTH = 4;
const READ_CAP = 32_000;
const DISK_CAP = 256 * 1024;

/** Both separators count, so a Windows path cannot slip through on Linux or the reverse. */
export function safeRelative(input: string): string {
  if (input.includes("\0")) throw new RepoReadError("That path is not allowed.", 400);
  const normalized = input.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new RepoReadError("Use a path inside the repository.", 403);
  }
  const parts = normalized.split("/").filter((part) => part.length > 0 && part !== ".");
  if (!parts.length || parts.some((part) => part === "..")) {
    throw new RepoReadError("That path is outside the repository.", 403);
  }
  return parts.join("/");
}

export function isSecretPath(rel: string): boolean {
  const path = rel.replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)\.env($|\.)/.test(path)) return true;
  if (/(^|\/)\.(npmrc|netrc|git-credentials)(\/|$)/.test(path)) return true;
  if (/(^|\/)(\.ssh|\.aws|\.gnupg)(\/|$)/.test(path)) return true;
  if (/(^|\/)(id_rsa|id_dsa|id_ed25519|id_ecdsa)($|\.)/.test(path)) return true;
  if (/(^|\/)(credentials|secrets)($|\.)/.test(path)) return true;
  if (/(^|\/)service-?account.*\.json$/.test(path)) return true;
  if (/\.(pem|p12|pfx|keystore|kdbx|key)$/.test(path)) return true;
  return false;
}

export function skippedDir(rel: string): boolean {
  return rel.replace(/\\/g, "/").split("/").some((part) => SKIP_DIRS.has(part));
}

function redact(text: string): string {
  return text
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, "$1 [redacted] $2")
    .replace(/((?:password|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*)(\S+)/gi, "$1[redacted]");
}

export async function readBounded(root: string, rel: string): Promise<{ path: string; text: string; truncated: boolean }> {
  const safe = safeRelative(rel);
  if (isSecretPath(safe) || skippedDir(safe)) {
    throw new RepoReadError("That file is not available.", 403);
  }
  if (await gitIgnored(root, safe)) throw new RepoReadError("That path is ignored by the repository.", 403);
  let full: string;
  try {
    full = await jailPath(root, safe.split("/").join(sep), true);
  } catch (error) {
    if (error instanceof GuardError) {
      const missing = error.message.includes("does not exist");
      throw new RepoReadError(missing ? "That file is not available." : "That path is outside the repository.", missing ? 404 : 403);
    }
    throw error;
  }
  const info = await stat(full);
  if (!info.isFile()) throw new RepoReadError("That path is a folder.", 400);
  const handle = await open(full, "r");
  try {
    const size = Math.min(info.size, DISK_CAP);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    const chunk = buffer.subarray(0, bytesRead);
    if (chunk.includes(0)) throw new RepoReadError("That file is not text.", 400);
    const text = redact(chunk.toString("utf8"));
    const truncated = info.size > READ_CAP || bytesRead < info.size;
    return { path: safe, text: text.slice(0, READ_CAP), truncated };
  } finally {
    await handle.close();
  }
}

async function gitIgnored(root: string, rel: string): Promise<boolean> {
  try {
    await git(root, ["check-ignore", "-q", "--", rel]);
    return true;
  } catch (error) {
    if (error instanceof GitError) return false;
    return false;
  }
}

async function listedFiles(root: string): Promise<string[]> {
  try {
    const top = (await git(root, ["rev-parse", "--show-toplevel"])).trim();
    // A folder sitting inside another checkout is not that checkout. Walk it.
    if (resolve(top) !== resolve(root)) return walkFiles(root, root, 0);
    const raw = await git(root, ["ls-files", "-co", "--exclude-standard", "-z"]);
    return raw.split("\0").map((path) => path.replace(/\\/g, "/")).filter(Boolean).slice(0, MAX_LIST);
  } catch {
    return walkFiles(root, root, 0);
  }
}

async function walkFiles(root: string, dir: string, depth: number): Promise<string[]> {
  if (depth > 8) return [];
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (found.length >= MAX_LIST) break;
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".git")) continue;
    const rel = relative(root, join(dir, entry.name)).split(sep).join("/");
    if (!rel || rel.startsWith("..")) continue;
    if (isSecretPath(rel)) continue;
    if (entry.isDirectory()) found.push(...(await walkFiles(root, join(dir, entry.name), depth + 1)));
    else if (entry.isFile()) found.push(rel);
  }
  return found;
}

function visible(path: string): boolean {
  return !isSecretPath(path) && !skippedDir(path);
}

function composeServices(text: string): string[] {
  const services: string[] = [];
  let inServices = false;
  for (const line of text.split("\n")) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (inServices && /^[^\s#]/.test(line)) break;
    const name = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (inServices && name) services.push(name[1]!);
  }
  return services;
}

function headings(text: string): string[] {
  return text
    .split("\n")
    .map((line) => /^#{1,3}\s+(.+?)\s*$/.exec(line)?.[1])
    .filter((line): line is string => Boolean(line))
    .slice(0, 24);
}

function routeHits(text: string): string[] {
  const hits: string[] = [];
  const re = /\.(get|post|put|patch|delete|head|options)\(\s*["'`]([^"'`]{1,120})["'`]/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) && hits.length < 40) {
    hits.push(`${match[1]!.toUpperCase()} ${match[2]}`);
  }
  return hits;
}

async function readQuiet(root: string, path: string, cap = 64_000): Promise<string> {
  try {
    const file = await readBounded(root, path);
    return file.text.slice(0, cap);
  } catch {
    return "";
  }
}

export interface RepoOverview {
  files: number;
  truncated: boolean;
  tree: string[];
  apps: string[];
  manifests: Array<{ path: string; kind: string; name?: string; workspaces?: string[]; scripts?: string[]; dependencies?: string[] }>;
  entryPoints: string[];
  routes: Array<{ file: string; calls: string[] }>;
  schema: Array<{ path: string; kind: "prisma" | "sql"; names: string[] }>;
  compose: Array<{ path: string; services: string[] }>;
  readme: Array<{ path: string; headings: string[] }>;
  notable: string[];
}

export async function buildOverview(root: string): Promise<RepoOverview> {
  const files = (await listedFiles(root)).filter(visible);
  const tree = files
    .filter((path) => path.split("/").length <= TREE_DEPTH)
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .slice(0, TREE_CAP);
  const apps = [
    ...new Set(
      files
        .map((path) => /^apps\/([^/]+)\/(package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/.exec(path)?.[1])
        .filter((name): name is string => Boolean(name)),
    ),
  ].sort();
  const manifestPaths = files.filter((path) =>
    /(^|\/)(package\.json|pnpm-workspace\.yaml|pyproject\.toml|Cargo\.toml|go\.mod|composer\.json|Gemfile|pom\.xml|build\.gradle|requirements\.txt)$/.test(path),
  ).slice(0, 16);
  const manifests = [];
  for (const path of manifestPaths) {
    const text = await readQuiet(root, path, 20_000);
    if (path.endsWith("package.json")) {
      try {
        const json = JSON.parse(text) as {
          name?: string;
          workspaces?: string[] | { packages?: string[] };
          scripts?: Record<string, string>;
          dependencies?: Record<string, string>;
          main?: string;
          bin?: string | Record<string, string>;
        };
        const workspaces = Array.isArray(json.workspaces) ? json.workspaces : json.workspaces?.packages;
        manifests.push({
          path,
          kind: "package.json",
          name: json.name,
          workspaces: workspaces?.slice(0, 20),
          scripts: Object.keys(json.scripts ?? {}).slice(0, 12),
          dependencies: Object.keys(json.dependencies ?? {}).slice(0, 40),
        });
      } catch {
        manifests.push({ path, kind: "package.json" });
      }
    } else if (path.endsWith("pnpm-workspace.yaml")) {
      const workspaces = text
        .split("\n")
        .map((line) => /^\s+-\s+(.+)$/.exec(line)?.[1]?.trim())
        .filter((line): line is string => Boolean(line));
      manifests.push({ path, kind: "pnpm-workspace", workspaces });
    } else {
      manifests.push({ path, kind: basename(path) });
    }
  }
  const entryPoints = files
    .filter((path) =>
      /(^|\/)(src\/)?(index|main|server|app)\.(ts|tsx|js|mjs|py|go|rs)$/.test(path) ||
      /(^|\/)(manage\.py|next\.config\.(ts|mjs|js)|cmd\/[^/]+\/main\.go)$/.test(path),
    )
    .filter((path) => path.split("/").length <= 5)
    .slice(0, 30);
  const routeFiles = files
    .filter((path) => /(^|\/)routes?\.(ts|js|py)$/.test(path) || /\/routes\/[^/]+\.(ts|js)$/.test(path) || /\/api\/[^/]+\/route\.(ts|js)$/.test(path))
    .slice(0, 20);
  const routes = [];
  for (const file of routeFiles) {
    const calls = routeHits(await readQuiet(root, file));
    if (calls.length) routes.push({ file, calls: calls.slice(0, 12) });
  }
  const schemaFiles = files.filter((path) => /schema\.prisma$/.test(path) || /(^|\/)(migrations|sql)\/.+\.sql$/.test(path)).slice(0, 12);
  const schema = [];
  for (const path of schemaFiles) {
    const text = await readQuiet(root, path);
    if (path.endsWith(".prisma")) {
      const names = [...text.matchAll(/^model\s+([A-Za-z_][A-Za-z0-9_]*)/gm)].map((match) => match[1]!).slice(0, 40);
      schema.push({ path, kind: "prisma" as const, names });
    } else {
      const names = [...text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?["`]?([A-Za-z0-9_]+)/gi)].map((match) => match[1]!).slice(0, 40);
      schema.push({ path, kind: "sql" as const, names });
    }
  }
  const composeFiles = files.filter((path) => /(^|\/)(docker-)?compose[^/]*\.ya?ml$/.test(path) || /(^|\/)docker-compose[^/]*\.ya?ml$/.test(path)).slice(0, 4);
  const compose = [];
  for (const path of composeFiles) {
    const services = composeServices(await readQuiet(root, path));
    if (services.length) compose.push({ path, services });
  }
  const readmeFiles = files.filter((path) => /(^|\/)readme\.md$/i.test(path)).slice(0, 4);
  const readme = [];
  for (const path of readmeFiles) {
    const found = headings(await readQuiet(root, path));
    if (found.length) readme.push({ path, headings: found });
  }
  const notable = files
    .filter((path) => /quick-capture|schema\.prisma|docker-compose|routes\.ts|readme\.md/i.test(path))
    .slice(0, 40);
  return {
    files: files.length,
    truncated: files.length > TREE_CAP || files.some((path) => path.split("/").length > TREE_DEPTH),
    tree,
    apps,
    manifests,
    entryPoints,
    routes,
    schema,
    compose,
    readme,
    notable,
  };
}

export function posixDir(path: string): string {
  return dirname(path).replace(/\\/g, "/");
}
