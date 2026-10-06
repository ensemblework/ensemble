/**
 * The folders the Code tab may list and review (`settings.code.roots`).
 *
 * This list is separate from the terminal's (`settings.terminal.roots`). The
 * terminal never reads it, and Code never reads the terminal's list. Both share
 * the guard rails in workspace/guard.ts; Code adds stricter checks when a
 * folder is added, because the Code tab works on every address, not only on
 * localhost.
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Settings } from "@ensemble/shared-types";
import { blockedReason, expandHome, GuardError, resolveWorkFolder, within } from "../workspace/guard.js";
import { requireHostAccess } from "./hosted-access.js";

/** Only `$executeRawUnsafe` is needed, so the hosted client and the desktop PGlite client both fit. */
type RawExecutor = { $executeRawUnsafe(query: string): Promise<number> };

/**
 * One-time upgrade: a saved settings row without a `code` section gets one,
 * holding a copy of the terminal's folders, so Code keeps the folders it used
 * before the lists were split. A row that already has `code` is never touched,
 * so a second run changes nothing. Removing every Code folder stores
 * `code.roots = []`, which also keeps it from coming back.
 *
 * This runs at startup rather than as a Prisma migration: on hosted Postgres,
 * scripts/migrate-deploy.mjs baselines pending migrations when the schema is
 * already in sync (it marks them applied without running their SQL), so a
 * data-only migration could be skipped. Startup runs on hosted and on desktop
 * PGlite alike.
 */
export const UPGRADE_CODE_FOLDERS_SQL = `
UPDATE "preferences"
SET "value" = jsonb_set(
      "value",
      '{code}',
      jsonb_build_object(
        'roots',
        CASE WHEN jsonb_typeof("value"->'terminal'->'roots') = 'array'
             THEN "value"->'terminal'->'roots'
             ELSE '[]'::jsonb END
      ),
      true
    ),
    "updated_at" = NOW()
WHERE "key" = 'hub.settings'
  AND jsonb_typeof("value") = 'object'
  AND "value"->'code' IS NULL`;

/** Returns how many saved settings rows were upgraded (0 on every later run). */
export async function upgradeCodeFolders(db: RawExecutor): Promise<number> {
  return db.$executeRawUnsafe(UPGRADE_CODE_FOLDERS_SQL);
}

function home(): string {
  return homedir();
}

/** A `..` segment anywhere in what the person typed. */
function hasParentSegment(input: string): boolean {
  return input.split(/[/\\]+/).some((part) => part === "..");
}

/** A dotfile or dot-folder anywhere under the home folder (`~/.foo`, `~/code/.secret`). */
export function dotUnderHome(path: string, homeDir = home()): string | null {
  if (!within(homeDir, path, false)) return null;
  const parts = relative(homeDir, path).split(sep);
  return parts.find((part) => part.startsWith(".")) ?? null;
}

/**
 * Resolves a folder someone wants Code to use, or throws GuardError (403).
 * Everything the terminal refuses is refused here too (resolveWorkFolder:
 * relative paths, links named directly, files, `/`, system folders, the home
 * folder itself, keys and app data, Ensemble's own code). On top of that:
 * `..` segments, dotfiles and dot-folders in the home folder, and a path
 * under home that only gets somewhere else through a link.
 */
export async function resolveCodeFolder(input: string, userId?: string): Promise<string> {
  await requireHostAccess(userId, "Code filesystem");
  const typed = typeof input === "string" ? input.trim() : "";
  if (!typed) throw new GuardError("Give the full path, starting with / or ~.");
  if (hasParentSegment(typed)) throw new GuardError("Write the folder's path without “..”.");
  const named = resolve(expandHome(typed));
  const homeDir = home();
  const typedDot = dotUnderHome(named, homeDir);
  if (typedDot) throw new GuardError(`${typedDot} in your home folder holds settings or app data. Pick a project folder.`);
  const real = await resolveWorkFolder(typed);
  const homeReal = await realpath(homeDir).catch(() => homeDir);
  if (within(homeDir, named, false) && !within(homeReal, real, false)) {
    throw new GuardError("That path goes through a link that leads out of your home folder. Choose the real folder.");
  }
  const realDot = dotUnderHome(real, homeReal);
  if (realDot) throw new GuardError(`${realDot} in your home folder holds settings or app data. Pick a project folder.`);
  return real;
}

/**
 * The saved Code folders that are still safe to use, resolved through links.
 * The list can also be written without going through Settings (an older
 * build, a restored backup), so each folder is checked again here: the real
 * path must pass blockedReason and must not be a dotfile or dot-folder in the
 * home folder. Anything gone, relative or blocked is skipped.
 */
export async function usableCodeRoots(settings: Pick<Settings, "code">, userId?: string): Promise<string[]> {
  await requireHostAccess(userId, "Code filesystem");
  const homeReal = await realpath(home()).catch(() => home());
  const out: string[] = [];
  for (const saved of settings.code.roots) {
    const path = expandHome(saved);
    if (!isAbsolute(path)) continue;
    const real = await realpath(path).catch(() => null);
    if (!real || blockedReason(real) || dotUnderHome(real, homeReal)) continue;
    out.push(real);
  }
  return [...new Set(out)];
}

/**
 * A settings save may remove Code folders or keep the ones already saved;
 * every folder it adds has to pass resolveCodeFolder. Added folders are
 * stored as their real path.
 */
export async function checkCodeRootsPatch(current: Pick<Settings, "code">, patch: unknown, userId?: string): Promise<unknown> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const code = (patch as { code?: unknown }).code;
  if (!code || typeof code !== "object" || Array.isArray(code)) return patch;
  const roots = (code as { roots?: unknown }).roots;
  if (roots === undefined) return patch;
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string")) {
    throw Object.assign(new Error("Code folders must be a list of paths."), { statusCode: 400, expose: true });
  }
  const kept = new Set(current.code.roots);
  const next: string[] = [];
  for (const root of roots as string[]) {
    next.push(kept.has(root) ? root : await resolveCodeFolder(root, userId));
  }
  return { ...(patch as object), code: { ...(code as object), roots: [...new Set(next)] } };
}
