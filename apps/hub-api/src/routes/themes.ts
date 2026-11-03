import path from "node:path";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { DiskThemeCache, loadOpenVsxTheme, searchThemes } from "../themes/openvsx.js";
import { declareModule } from "../lib/module-gate.js";
import { registerEditorTheme } from "../node/editor-theme.js";
import { accountIdOf } from "../lib/auth.js";
import { requireWebPerson } from "../devices/web-unlock.js";
import { isHosted } from "../lib/hosted-access.js";
import { isVisitor } from "../sharing/context.js";

const NS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VER = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

const SearchQuery = z.object({
  q: z.string().max(80).optional().default(""),
});

const LoadQuery = z.object({
  namespace: z.string().regex(NS),
  name: z.string().regex(NS),
  version: z.string().regex(VER),
  label: z.string().min(1).max(80),
});

export async function themeRoutes(app: FastifyInstance): Promise<void> {
  declareModule(app, "code");
  registerThemeEndpoints(app, "/api/themes");
  registerEditorTheme(app, request => {
    if (request.authVia === "session" || isHosted()) requireWebPerson(request);
    const accountId = accountIdOf(request);
    if (isVisitor(accountId) || (request.tokenScope && request.tokenScope !== "full")) throw Object.assign(new Error("Open editor themes from your own account."), { statusCode: 403 });
    return accountId;
  }, "/api/themes");
}

export function registerThemeEndpoints(app: FastifyInstance, prefix: string, authorize?: (request: FastifyRequest) => unknown): void {
  const cache = new DiskThemeCache(path.resolve(process.cwd(), ".theme-cache"));

  app.get(`${prefix}/search`, async (request) => {
    authorize?.(request);
    const query = SearchQuery.parse(request.query);
    return searchThemes(query.q, { cache });
  });

  app.get(`${prefix}/openvsx`, async (request) => {
    authorize?.(request);
    const query = LoadQuery.parse(request.query);
    return loadOpenVsxTheme(query, { cache });
  });
}
