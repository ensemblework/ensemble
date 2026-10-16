import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { newApiToken, sha256 } from "../lib/auth.js";
import { appendLedger } from "../lib/ledger.js";
import { hookScriptPath } from "./engines/registry.js";

export async function installEditorHook(
  prisma: PrismaClient,
  userId: string,
  target: string,
  options: { project?: string; remove?: boolean } = {},
): Promise<string> {
  const args = [
    hookScriptPath(),
    options.remove ? "uninstall" : "install",
    "--target",
    target,
  ];
  if (options.project) args.push("--project", options.project);
  if (!options.remove) {
    const saved = await readFile(
      join(homedir(), ".ensemble", "hook.json"),
      "utf8",
    )
      .then((text) => JSON.parse(text) as { token?: unknown })
      .catch(() => null);
    const valid =
      typeof saved?.token === "string" &&
      (await prisma.apiToken.findFirst({
        where: {
          tokenHash: sha256(saved.token),
          userId,
          revokedAt: null,
          scope: "hooks",
        },
      }));
    if (!valid) {
      const { token, hash, prefix } = newApiToken();
      await prisma.apiToken.create({
        data: {
          userId,
          name: "Agent hooks (this computer)",
          tokenHash: hash,
          prefix,
          scope: "hooks",
        },
      });
      await appendLedger({
        userId,
        actor: "me",
        action: "token.create",
        payload: { name: "Agent hooks", prefix, scope: "hooks" },
      });
      args.push("--token", token, "--url", "http://127.0.0.1:4000");
    }
  }
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  if (result.status !== 0)
    throw Object.assign(
      new Error(
        "Ensemble could not connect this editor automatically. Try connecting it again in Settings → Connections.",
      ),
      { statusCode: 500 },
    );
  return result.stdout.trim();
}
