import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadSettings, saveSettings } from "../lib/settings.js";
import { checkCodeRootsPatch } from "../lib/code-folders.js";
import { setOwnModule } from "../lib/own-modules.js";
import { connectionState, listConnectors } from "../connectors/base.js";
import { mirrorSettings } from "../spaces/store.js";

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", async (request) => {
    const settings = await loadSettings(app.prisma, request.userId);
    const connectors = await Promise.all(
      listConnectors().map(async (connector) => ({
        id: connector.id,
        label: connector.label,
        configured: (await connectionState(request.userId, connector)).configured,
      })),
    );
    return { settings, connectors };
  });

  app.patch("/api/settings", async (request) => {
    // Code folders added through a plain settings save get the same checks as POST /api/code/folders.
    const body = z.record(z.unknown()).parse(request.body);
    const current = await loadSettings(app.prisma, request.userId);
    const patch = await checkCodeRootsPatch(current, body, request.userId);
    const settings = await saveSettings(app.prisma, request.userId, patch);
    await mirrorSettings(app.prisma, request.userId);
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
