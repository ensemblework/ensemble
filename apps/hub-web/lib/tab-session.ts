/** Per-tab caches. A new sign-in on the same tab must not keep the previous user's data. */

export const MODULE_CACHE_KEY = "ensemble.modules";
export const SHELL_USER_KEY = "ensemble.shell-user";
export const PLOTS_WORKSPACE_KEY = "ensemble.plots.workspace";

export type TabStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

type ModuleRecord = { userId: string | null; modules: string };

function readRaw(storage: TabStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(storage: TabStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // private mode
  }
}

function drop(storage: TabStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // private mode
  }
}

function parseModuleRecord(raw: string): ModuleRecord | null {
  try {
    const parsed = JSON.parse(raw) as { userId?: unknown; modules?: unknown };
    if (!parsed || typeof parsed !== "object" || typeof parsed.modules !== "string") return null;
    const userId = typeof parsed.userId === "string" ? parsed.userId : null;
    return { userId, modules: parsed.modules };
  } catch {
    return null;
  }
}

/**
 * Modules for this tab. A missing user id is the fast path before the shell
 * returns. A known user id only reads a record stored for that user. A legacy
 * raw string has no owner, so it is ignored once the user is known.
 */
export function readModuleCache(storage: TabStorage, userId: string | null): string | null {
  const raw = readRaw(storage, MODULE_CACHE_KEY);
  if (raw == null) return null;
  const record = parseModuleRecord(raw);
  if (!record) return userId ? null : raw;
  if (userId && record.userId && record.userId !== userId) return null;
  if (userId && !record.userId) return null;
  return record.modules;
}

/** Remember modules for this user. A user change drops the other tab caches. */
export function syncModuleCache(storage: TabStorage, userId: string, modules: string): void {
  const current = parseModuleRecord(readRaw(storage, MODULE_CACHE_KEY) ?? "");
  if (current?.userId && current.userId !== userId) {
    drop(storage, SHELL_USER_KEY);
    drop(storage, PLOTS_WORKSPACE_KEY);
  }
  writeRaw(storage, MODULE_CACHE_KEY, JSON.stringify({ userId, modules } satisfies ModuleRecord));
}

export function clearTabSession(storage: TabStorage): void {
  drop(storage, MODULE_CACHE_KEY);
  drop(storage, SHELL_USER_KEY);
  drop(storage, PLOTS_WORKSPACE_KEY);
}

export function clearBrowserTabSession(): void {
  if (typeof window === "undefined") return;
  clearTabSession(window.sessionStorage);
}

type WorkspacePayload = { workspace: { id: string; title: string; config: unknown; code: string; updatedAt: string } };

function parseWorkspace(raw: string): { userId: string | null; payload: WorkspacePayload } | null {
  try {
    const parsed = JSON.parse(raw) as { userId?: unknown; workspace?: { id?: string } };
    if (!parsed?.workspace?.id) return null;
    const userId = typeof parsed.userId === "string" ? parsed.userId : null;
    return { userId, payload: { workspace: parsed.workspace as WorkspacePayload["workspace"] } };
  } catch {
    return null;
  }
}

export function plotsWorkspaceOwner(storage: TabStorage): string | null {
  const raw = readRaw(storage, PLOTS_WORKSPACE_KEY);
  if (!raw) return null;
  return parseWorkspace(raw)?.userId ?? null;
}

/** Cached plots workspace. A different signed-in user does not see it. */
export function readPlotsWorkspaceCache(storage: TabStorage, userId: string | null): WorkspacePayload | undefined {
  const raw = readRaw(storage, PLOTS_WORKSPACE_KEY);
  if (!raw) return undefined;
  const parsed = parseWorkspace(raw);
  if (!parsed) return undefined;
  if (userId && parsed.userId && parsed.userId !== userId) return undefined;
  return parsed.payload;
}

export function writePlotsWorkspaceCache(storage: TabStorage, userId: string | null, payload: WorkspacePayload): void {
  writeRaw(storage, PLOTS_WORKSPACE_KEY, JSON.stringify({ userId, workspace: payload.workspace }));
}
