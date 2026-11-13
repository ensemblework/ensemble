import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadSettings, saveSettings } from "../lib/settings.js";
import { checkCodeRootsPatch } from "../lib/code-folders.js";
import { setOwnModule } from "../lib/own-modules.js";
import { connectionState, listConnectors } from "../connectors/base.js";
import { mirrorSettings } from "../spaces/store.js";
import { isEmailAddress, timeZoneName } from "@ensemble/shared-types";
import { registerEditorTheme } from "../node/editor-theme.js";
import { accountIdOf, settingsUserOf } from "../lib/auth.js";
import { requireWebPerson } from "../devices/web-unlock.js";
import { isHosted } from "../lib/hosted-access.js";
import { isVisitor } from "../sharing/context.js";
import { saveBase } from "../lib/save-conflict.js";
import { sseHub } from "../lib/sse.js";

/** Settings › Account › You. Refused with a reason instead of saved, so a typo never becomes the stored value. */
export function checkIdentityPatch(body: Record<string, unknown>): Record<string, unknown> {
  const next = { ...body };
  if ("email" in body) {
    if (typeof body.email !== "string" || !isEmailAddress(body.email)) throw Object.assign(new Error("Enter an email address like name@example.com."), { statusCode: 400 });
    next.email = body.email.trim();
  }
  if ("timezone" in body) {
    const zone = typeof body.timezone === "string" ? timeZoneName(body.timezone) : null;
    if (!zone) throw Object.assign(new Error("Pick a time zone from the list, such as Europe/London."), { statusCode: 400 });
    next.timezone = zone;
    next.timezoneMode = body.timezoneMode ?? "manual";
  }
  return next;
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  registerEditorTheme(app, request => {
    if (request.authVia === "session" || isHosted()) requireWebPerson(request);
    const accountId = accountIdOf(request);
    if (isVisitor(accountId) || (request.tokenScope && request.tokenScope !== "full")) throw Object.assign(new Error("Open editor themes from your own account."), { statusCode: 403 });
    return accountId;
  }, "/api/settings/editor-theme");
  app.get("/api/settings", async (request) => {
    const settings = await loadSettings(app.prisma, request.userId);
    const connectors = await Promise.all(
      listConnectors().map(async (connector) => ({
        id: connector.id,
        label: connector.label,
        configured: (await connectionState(request.userId, connector)).configured,
      })),
    );
    return { settings, connectors, scope: settingsUserOf(request) };
  });

  app.patch("/api/settings", async (request) => {
    // Code folders added through a plain settings save get the same checks as POST /api/code/folders.
    const { _base, ...submitted } = z.record(z.unknown()).parse(request.body);
    const body = checkIdentityPatch(submitted);
    const current = await loadSettings(app.prisma, request.userId);
    const patch = await checkCodeRootsPatch(current, body, request.userId);
    const settings = await saveSettings(app.prisma, request.userId, patch, saveBase(request));
    await mirrorSettings(app.prisma, request.userId);
    sseHub.publish(accountIdOf(request), { event: "settings.changed", to: accountIdOf(request), data: {} });
    return { settings };
  });

  // Own modules only. Desk switching and the marketplace stay on their tester gate.
  app.put("/api/settings/modules", async (request) => {
    const body = request.body as { id?: unknown; on?: unknown } | null;
    if (!body || typeof body !== "object" || typeof body.id !== "string" || typeof body.on !== "boolean") {
      const error = new Error("Say which feature, and whether it is on.");
      (error as { statusCode?: number }).statusCode = 400;
      throw error;
    }
    const modules = await setOwnModule(app.prisma, request.userId, body.id, body.on);
    return { modules };
  });
}
