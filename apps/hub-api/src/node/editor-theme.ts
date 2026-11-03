import { ensembleDefaultTheme, loadBuiltinTheme, parseOpenVsxThemeId, sanitizeIdeTheme } from "@ensemble/ide-theme";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { loadSettings, saveSettings } from "../lib/settings.js";
import { loadOpenVsxTheme } from "../themes/openvsx.js";
import { publishTo } from "./events.js";

const KEY = "ide.theme.current";
export function registerEditorTheme(app: FastifyInstance, accountOf: (request: FastifyRequest) => string, prefix = "/api/node/themes") {
  app.get(`${prefix}/current`, async request => {
    const accountId = accountOf(request);
    const [settings, stored] = await Promise.all([
      loadSettings(app.prisma, accountId),
      app.prisma.preference.findFirst({ where: { userId: accountId, key: KEY, deletedAt: null } }),
    ]);
    const id = settings.ideTheme.activeId;
    const saved = sanitizeIdeTheme(stored?.value);
    if (saved?.id === id) return { theme: saved };
    const builtin = await loadBuiltinTheme(id);
    if (builtin) return { theme: builtin };
    const remote = parseOpenVsxThemeId(id);
    if (remote) {
      const loaded = await loadOpenVsxTheme(remote);
      if (loaded.theme) return { theme: loaded.theme };
      throw Object.assign(new Error(loaded.reason || "Your saved editor theme could not be loaded."), { statusCode: 422 });
    }
    if (id === ensembleDefaultTheme.id) return { theme: ensembleDefaultTheme };
    throw Object.assign(new Error("Import this theme again to save its colour data to your account."), { statusCode: 409 });
  });
  app.put(`${prefix}/current`, { bodyLimit: 256 * 1024 }, async request => {
    const accountId = accountOf(request);
    const theme = sanitizeIdeTheme((request.body as { theme?: unknown } | null)?.theme);
    if (!theme) throw Object.assign(new Error("Choose a supported editor colour theme."), { statusCode: 400 });
    await app.prisma.$transaction(async tx => {
      await tx.preference.upsert({
        where: { userId_key: { userId: accountId, key: KEY } },
        create: { userId: accountId, key: KEY, value: theme, source: "me" },
        update: { value: theme, deletedAt: null, source: "me" },
      });
      await saveSettings(tx, accountId, { ideTheme: { activeId: theme.id } });
    });
    publishTo([accountId], "node.editor-theme", {});
    return { theme };
  });
}
