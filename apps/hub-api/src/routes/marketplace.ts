import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { OPTIONAL_MODULES, parseModules } from "@ensemble/shared-types/modules";
import { modulesRemoved, type MarketTemplate } from "@ensemble/shared-types/marketplace";
import { WIDGET_REGISTRY, type LayoutDocument, type WidgetId } from "@ensemble/shared-types/widgets";
import { readOrder, ORDER_KEY } from "../context/order.js";
import { loadSettings } from "../lib/settings.js";
import { canSwitchDesks, seasonEnded } from "../lib/dev-tools.js";
import { applyMarketplace, revertMarketplace } from "../marketplace/apply.js";
import { CATALOG } from "../marketplace/schema.js";

const ApplyBody = z.object({ id: z.string().min(1).max(80) }).strict();

function placements(document: unknown): string[] {
  if (!document || typeof document !== "object") return [];
  const rows = (document as LayoutDocument).placements;
  return Array.isArray(rows) ? rows.map((row) => row.type) : [];
}

function widgetDiff(before: unknown, after: LayoutDocument | undefined) {
  const left = new Set(placements(before));
  const right = new Set(placements(after));
  return {
    added: [...right].filter((id) => !left.has(id)),
    removed: [...left].filter((id) => !right.has(id)),
  };
}

export function templateDiff(
  template: MarketTemplate,
  user: { moduleSet: string; chromeLabels: unknown },
  settings: { assistant: { actAs: string }; appearance: { accent: string; accentCustom: string | null } },
  layouts: { today: unknown; context: unknown; board: unknown },
  lens: { group: string; kinds?: string[] } | null,
) {
  const current = parseModules(user.moduleSet);
  const next = new Set(template.modules);
  const labels = user.chromeLabels && typeof user.chromeLabels === "object" ? (user.chromeLabels as Record<string, string>) : {};
  const labelChanges = Object.entries(template.labels ?? {}).filter(([key, value]) => labels[key] !== value);
  return {
    modulesOff: OPTIONAL_MODULES.filter((id) => current.has(id) && !next.has(id)),
    modulesOn: OPTIONAL_MODULES.filter((id) => next.has(id) && !current.has(id)),
    labels: labelChanges.map(([key, value]) => ({ key, value })),
    widgets: {
      today: widgetDiff(layouts.today, template.layouts.today),
      context: widgetDiff(layouts.context, template.layouts.context),
      board: widgetDiff(layouts.board, template.layouts.board),
    },
    actAs: settings.assistant.actAs === template.actAs ? null : { from: settings.assistant.actAs, to: template.actAs },
    accent:
      template.accent && !settings.appearance.accentCustom && settings.appearance.accent !== template.accent
        ? { from: settings.appearance.accent, to: template.accent }
        : null,
    lens:
      template.lens && (lens?.group !== template.lens.groupBy || (lens?.kinds ?? []).join() !== template.lens.kinds.join())
        ? { groupBy: template.lens.groupBy, kinds: template.lens.kinds }
        : null,
    lines: diffLines(template, {
      modulesOff: OPTIONAL_MODULES.filter((id) => current.has(id) && !next.has(id)),
      modulesOn: OPTIONAL_MODULES.filter((id) => next.has(id) && !current.has(id)),
      labels: labelChanges.map(([key, value]) => ({ key, value })),
      today: widgetDiff(layouts.today, template.layouts.today),
      context: widgetDiff(layouts.context, template.layouts.context),
      accent:
        template.accent && !settings.appearance.accentCustom && settings.appearance.accent !== template.accent
          ? { from: settings.appearance.accent, to: template.accent }
          : null,
    }),
  };
}

function tileName(id: string): string {
  const spec = WIDGET_REGISTRY[id as WidgetId];
  return spec?.label ?? id;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function diffLines(
  template: MarketTemplate,
  diff: {
    modulesOff: string[];
    modulesOn: string[];
    labels: Array<{ key: string; value: string }>;
    today: { added: string[]; removed: string[] };
    context: { added: string[]; removed: string[] };
    accent: { from: string; to: string } | null;
  },
): string[] {
  const lines: string[] = [];
  if (diff.modulesOff.length) lines.push(`${joinNames(diff.modulesOff.map((id) => id[0]!.toUpperCase() + id.slice(1)))} will not open.`);
  else lines.push("Every section you have now stays open.");
  if (diff.modulesOn.length) lines.push(`${joinNames(diff.modulesOn.map((id) => id[0]!.toUpperCase() + id.slice(1)))} opens again.`);
  for (const row of diff.labels) lines.push(`“${row.key}” is called “${row.value}”.`);
  const todayAdded = diff.today.added.map(tileName);
  const todayRemoved = diff.today.removed.map(tileName);
  if (todayAdded.length) lines.push(`Today adds ${joinNames(todayAdded)}.`);
  if (todayRemoved.length) lines.push(`Today removes ${joinNames(todayRemoved)}.`);
  const contextAdded = diff.context.added.map(tileName);
  if (contextAdded.length) lines.push(`Context adds ${joinNames(contextAdded)}.`);
  if (diff.accent) lines.push(`The accent becomes ${diff.accent.to}.`);
  if (template.lens) lines.push(`The board groups by ${template.lens.groupBy}.`);
  return lines;
}

function publicTemplate(template: MarketTemplate) {
  return {
    id: template.id,
    version: template.version,
    persona: template.persona,
    name: template.name,
    blurb: template.blurb,
    accent: template.accent ?? null,
    actAs: template.actAs,
    highlights: template.highlights,
    modules: template.modules,
    removes: modulesRemoved(template),
    labels: template.labels ?? {},
    lens: template.lens ?? null,
    expiresInDays: template.expiresInDays ?? null,
    layouts: template.layouts,
  };
}

export async function marketplaceRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  app.addHook("preHandler", async (request, reply) => {
    if (await canSwitchDesks(prisma, request.userId)) return;
    const body = request.body as { id?: string } | undefined;
    if (request.method === "POST" && request.url.split("?")[0] === "/api/marketplace/apply" && body?.id === "default" && (await seasonEnded(prisma, request.userId))) {
      return;
    }
    return reply.code(403).send({ error: "Desk switching is for testers." });
  });

  app.get("/api/marketplace/templates", async () => {
    return {
      templates: CATALOG.map((template) => ({
        id: template.id,
        persona: template.persona,
        name: template.name,
        blurb: template.blurb,
        accent: template.accent ?? null,
        removes: [...modulesRemoved(template)].sort(),
        widgets: [
          ...new Set([
            ...template.layouts.today.placements.map((row) => row.type),
            ...template.layouts.context.placements.map((row) => row.type),
            ...(template.layouts.board?.placements.map((row) => row.type) ?? []),
          ]),
        ],
        expiresInDays: template.expiresInDays ?? null,
      })),
    };
  });

  app.get("/api/marketplace/templates/:id", async (request) => {
    const id = (request.params as { id: string }).id;
    const template = CATALOG.find((row) => row.id === id);
    if (!template) throw Object.assign(new Error("Unknown template."), { statusCode: 404 });
    const [user, layouts, settings, pref] = await Promise.all([
      prisma.user.findUnique({ where: { id: request.userId } }),
      prisma.widgetLayout.findMany({ where: { userId: request.userId } }),
      loadSettings(prisma, request.userId),
      prisma.preference.findFirst({ where: { userId: request.userId, key: ORDER_KEY, deletedAt: null } }),
    ]);
    const doc = (surface: string) => layouts.find((row) => row.surface === surface)?.document ?? null;
    const lens = pref ? readOrder(pref.value) : null;
    return {
      template: publicTemplate(template),
      applied: user?.activeTemplateId === template.id && user.appliedVersion === template.version,
      diff: templateDiff(
        template,
        { moduleSet: user?.moduleSet ?? "", chromeLabels: user?.chromeLabels ?? {} },
        settings,
        { today: doc("today"), context: doc("context"), board: doc("board") },
        lens,
      ),
    };
  });

  app.post("/api/marketplace/apply", async (request) => {
    const body = ApplyBody.parse(request.body ?? {});
    return applyMarketplace(prisma, request.userId, body.id);
  });

  app.get("/api/marketplace/history", async (request) => {
    const [rows, user] = await Promise.all([
      prisma.templateApplication.findMany({
        where: { userId: request.userId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, templateId: true, createdAt: true },
      }),
      prisma.user.findUnique({ where: { id: request.userId }, select: { activeTemplateId: true } }),
    ]);
    const nameOf = (id: string) => CATALOG.find((row) => row.id === id)?.name ?? (id === "default" ? "Default" : id);
    return {
      activeTemplateId: user?.activeTemplateId ?? "default",
      activeName: nameOf(user?.activeTemplateId ?? "default"),
      history: rows.map((row) => ({
        id: row.id,
        templateId: row.templateId,
        name: nameOf(row.templateId),
        at: row.createdAt.toISOString(),
      })),
    };
  });

  app.get("/api/marketplace/samples", async (request) => {
    const userId = request.userId;
    const [task, deliverable, person, artifact] = await Promise.all([
      prisma.task.findFirst({ where: { userId, deletedAt: null, sourceRef: { startsWith: "mkt:" } }, select: { id: true } }),
      prisma.deliverable.findFirst({ where: { userId, deletedAt: null, sourceRef: { startsWith: "mkt:" } }, select: { id: true } }),
      prisma.person.findFirst({ where: { userId, deletedAt: null, upn: { startsWith: "mkt:" } }, select: { id: true } }),
      prisma.artifact.findFirst({ where: { userId, deletedAt: null, externalId: { startsWith: "mkt:" } }, select: { id: true } }),
    ]);
    return { present: Boolean(task || deliverable || person || artifact) };
  });

  app.post("/api/marketplace/samples/clear", async (request) => {
    const userId = request.userId;
    const now = new Date();
    const [tasks, deliverables, people] = await prisma.$transaction([
      prisma.task.updateMany({ where: { userId, deletedAt: null, sourceRef: { startsWith: "mkt:" } }, data: { deletedAt: now } }),
      prisma.deliverable.updateMany({ where: { userId, deletedAt: null, sourceRef: { startsWith: "mkt:" } }, data: { deletedAt: now } }),
      prisma.person.updateMany({ where: { userId, deletedAt: null, upn: { startsWith: "mkt:" } }, data: { deletedAt: now } }),
    ]);
    await prisma.artifact.updateMany({
      where: { userId, deletedAt: null, externalId: { startsWith: "mkt:" } },
      data: { deletedAt: now },
    });
    return { cleared: tasks.count + deliverables.count + people.count };
  });

  app.post("/api/marketplace/revert", async (request) => {
    if (request.body && typeof request.body === "object" && Object.keys(request.body as object).length) {
      throw Object.assign(new Error("Revert takes no body."), { statusCode: 400 });
    }
    return revertMarketplace(prisma, request.userId);
  });
}
