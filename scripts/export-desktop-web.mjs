/**
 * Static export of hub-web for the desktop shell.
 *
 * Middleware cannot ship in an export, so it is parked for the duration of
 * this build and restored afterwards. `pnpm dev` and `pnpm --filter
 * @ensemble/hub-web build` do not set ENSEMBLE_DESKTOP_EXPORT, so they are unchanged.
 */
import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./desktop-spawn.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const middleware = join(root, "apps/hub-web/middleware.ts");
const parked = join(root, "apps/hub-web/middleware.desktop-bak.ts");

if (!existsSync(middleware)) {
  console.error("apps/hub-web/middleware.ts is missing.");
  process.exit(1);
}
if (existsSync(parked)) {
  console.error("A previous desktop export left middleware.desktop-bak.ts behind. Move it back to middleware.ts first.");
  process.exit(1);
}

renameSync(middleware, parked);
let status = 1;
try {
  status = run("pnpm", ["--filter", "@ensemble/hub-web", "exec", "next", "build"], {
    cwd: root,
    env: {
      ...process.env,
      ENSEMBLE_DESKTOP_EXPORT: "1",
      NEXT_PUBLIC_HUB_API: process.env.NEXT_PUBLIC_HUB_API?.trim() || "http://127.0.0.1:4000",
    },
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  status = 1;
} finally {
  try {
    if (existsSync(parked)) renameSync(parked, middleware);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    status = status || 1;
  }
}
process.exit(status);
