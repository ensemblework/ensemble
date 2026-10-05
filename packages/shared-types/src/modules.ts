/**
 * Optional product modules. Core pages (Today, Board, Context, tasks) are not in this list.
 * A null or empty set means none of these are on. That is fail-closed.
 */

/** `diagrams` is on for every template and Default; a template can still leave it out. */
export const OPTIONAL_MODULES = ["code", "workspace", "runs", "metrics", "skills", "diagrams", "plots"] as const;
export type OptionalModule = (typeof OPTIONAL_MODULES)[number];

/** Sorted, stable, and short enough for a session column. */
export const FULL_MODULE_SET = "code,diagrams,metrics,runs,skills,workspace";

export const MODULE_DENIED = "Not part of this template.";

export class BadPathError extends Error {
  constructor() {
    super("Malformed path.");
    this.name = "BadPathError";
  }
}

const KNOWN = new Set<string>(OPTIONAL_MODULES);

/**
 * One canonical path for the gate and the router.
 * Decodes until stable, lowercases, collapses slashes, drops a trailing slash,
 * matrix parameters, and dot segments. A broken percent-encoding throws.
 */
export function normalizePath(input: string): string {
  let path = input.split("#")[0] ?? input;
  path = path.split("?")[0] ?? path;
  let previous = "";
  for (let pass = 0; pass < 5 && path !== previous; pass++) {
    previous = path;
    if (/%(?![0-9a-fA-F]{2})/.test(path)) throw new BadPathError();
    try {
      path = decodeURIComponent(path);
    } catch {
      throw new BadPathError();
    }
    if (path.includes("\0")) throw new BadPathError();
    const query = path.indexOf("?");
    if (query >= 0) path = path.slice(0, query);
    const hash = path.indexOf("#");
    if (hash >= 0) path = path.slice(0, hash);
  }
  if (/%(?![0-9a-fA-F]{2})|%[0-9a-fA-F]{2}/.test(path)) throw new BadPathError();
  path = path.replace(/\\/g, "/").toLowerCase();
  const out: string[] = [];
  for (const segment of path.split("/")) {
    const clean = (segment.split(";")[0] ?? "").trim();
    if (!clean || clean === ".") continue;
    if (clean === "..") {
      out.pop();
      continue;
    }
    out.push(clean);
  }
  return `/${out.join("/")}`;
}

export function parseModules(value: string | null | undefined): Set<OptionalModule> {
  const out = new Set<OptionalModule>();
  if (!value) return out;
  for (const part of value.split(",")) {
    const id = part.trim();
    if (KNOWN.has(id)) out.add(id as OptionalModule);
  }
  return out;
}

export function serializeModules(ids: Iterable<string>): string {
  return [...new Set(ids)].filter((id) => KNOWN.has(id)).sort().join(",");
}

export function hasModule(value: string | null | undefined, id: OptionalModule): boolean {
  return parseModules(value).has(id);
}

/** The optional module that owns this path, or null when the path is core or unknown. */
export function moduleForPath(path: string): OptionalModule | null {
  const raw = normalizePath(path);
  if (
    raw === "/code" ||
    raw.startsWith("/code/") ||
    raw === "/api/code" ||
    raw.startsWith("/api/code/") ||
    raw === "/api/terminal" ||
    raw.startsWith("/api/terminal/") ||
    // IDE themes and reading a repo's files belong to the code space.
    raw === "/api/themes" ||
    raw.startsWith("/api/themes/") ||
    /^\/api\/bridge\/repos\/[^/]+\/(overview|file)$/.test(raw)
  ) {
    return "code";
  }
  if (
    raw === "/diagrams" ||
    raw.startsWith("/diagrams/") ||
    raw === "/api/diagrams" ||
    raw.startsWith("/api/diagrams/") ||
    raw === "/api/bridge/diagrams" ||
    raw.startsWith("/api/bridge/diagrams/")
  ) {
    return "diagrams";
  }
  if (
    raw === "/workspace" ||
    raw.startsWith("/workspace/") ||
    raw === "/api/workspace" ||
    raw.startsWith("/api/workspace/") ||
    raw === "/api/agent" ||
    raw.startsWith("/api/agent/") ||
    /^\/api\/activity\/[^/]+/.test(raw)
  ) {
    return "workspace";
  }
  if (raw === "/runs" || raw.startsWith("/runs/") || raw === "/api/runs" || raw.startsWith("/api/runs/")) return "runs";
  if (
    raw === "/metrics" ||
    raw.startsWith("/metrics/") ||
    raw === "/api/metrics" ||
    raw.startsWith("/api/metrics/") ||
    raw === "/api/ledger/verify" ||
    raw.startsWith("/api/ledger/")
  ) {
    return "metrics";
  }
  if (
    raw === "/skills" ||
    raw.startsWith("/skills/") ||
    raw === "/api/skills" ||
    raw.startsWith("/api/skills/") ||
    raw === "/api/bridge/skills" ||
    raw.startsWith("/api/bridge/skills/")
  ) {
    return "skills";
  }
  if (
    raw === "/plots" ||
    raw.startsWith("/plots/") ||
    raw === "/api/plots" ||
    raw.startsWith("/api/plots/") ||
    raw === "/api/bridge/plots" ||
    raw.startsWith("/api/bridge/plots/")
  ) {
    return "plots";
  }
  return null;
}

export function moduleDenied(path: string, modules: string | null | undefined): boolean {
  let needed: OptionalModule | null;
  try {
    needed = moduleForPath(path);
  } catch (error) {
    if (error instanceof BadPathError) return true;
    throw error;
  }
  return needed !== null && !hasModule(modules, needed);
}

/** Data kinds that belong to an optional module. Core kinds are absent. */
export function moduleForKind(kind: string): OptionalModule | null {
  if (kind === "skill") return "skills";
  if (kind === "run" || kind === "runs") return "runs";
  if (kind === "review" || kind === "code") return "code";
  if (kind === "diagram" || kind === "diagrams") return "diagrams";
  if (kind === "plot" || kind === "plots") return "plots";
  if (kind === "workspace" || kind === "job" || kind === "session") return "workspace";
  if (kind === "metric" || kind === "metrics" || kind === "ledger") return "metrics";
  return null;
}

export function kindAllowed(modules: string | null | undefined, kind: string): boolean {
  const needed = moduleForKind(kind);
  return needed === null || hasModule(modules, needed);
}
