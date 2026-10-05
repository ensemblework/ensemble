import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { isOnboardingRole, templateById } from "@ensemble/shared-types/templates";
import { TEMPLATE_CARDS } from "@ensemble/shared-types/manifest";
import { defaultLayout, sanitizeLayout, type LayoutSurface } from "@ensemble/shared-types/widgets";
import { applyOnboarding, documentsFor } from "../layouts/apply.js";
import { assertSurface, parseLayout } from "../layouts/document.js";

const OnboardingBody = z.object({
  role: z.string(),
  templateId: z.string(),
});

export async function layoutsRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  app.get("/api/onboarding/templates", async (request) => {
    const role = z.object({ role: z.string().optional() }).parse(request.query).role ?? "";
    const cards = TEMPLATE_CARDS.filter((card) => !role || card.role === role).map(({ id, role: cardRole, name, blurb, image, imageLight }) => ({
      id,
      role: cardRole,
      name,
      blurb,
      image,
      imageLight,
    }));
    return { templates: cards };
  });

  app.post("/api/onboarding", async (request) => {
    const body = OnboardingBody.parse(request.body);
    if (!isOnboardingRole(body.role)) throw Object.assign(new Error("Pick a role."), { statusCode: 400 });
    const template = templateById(body.templateId);
    if (!template || template.role !== body.role) throw Object.assign(new Error("Pick a template for that role."), { statusCode: 400 });
    const applied = await applyOnboarding(prisma, request.userId, template.id);
    return { role: applied.role, templateId: applied.id, onboardingComplete: true };
  });

  app.get("/api/layouts/:surface", async (request) => {
    const surface = assertSurface((request.params as { surface: string }).surface);
    return readLayout(prisma, request.userId, surface);
  });

  app.put("/api/layouts/:surface", async (request) => {
    const surface = assertSurface((request.params as { surface: string }).surface);
    const document = parseLayout(surface, request.body);
    const projectIds = [...new Set(document.placements.flatMap((row) => (row.config?.projectId ? [row.config.projectId] : [])))];
    if (projectIds.length) {
      const owned = await prisma.project.count({ where: { userId: request.userId, id: { in: projectIds }, deletedAt: null } });
      if (owned !== projectIds.length) throw Object.assign(new Error("That project is not yours."), { statusCode: 400 });
    }
    const user = await prisma.user.findUnique({ where: { id: request.userId }, select: { onboardingTemplateId: true } });
    const row = await prisma.widgetLayout.upsert({
      where: { userId_surface: { userId: request.userId, surface } },
      create: {
        userId: request.userId,
        surface,
        templateId: user?.onboardingTemplateId ?? null,
        document: document as object,
      },
      update: { document: document as object },
    });
    return { surface, document: row.document, templateId: row.templateId, source: "saved" as const, ignored: [] as string[] };
  });

  app.post("/api/layouts/:surface/reset", async (request) => {
    const surface = assertSurface((request.params as { surface: string }).surface);
    const user = await prisma.user.findUnique({
      where: { id: request.userId },
      select: { onboardingTemplateId: true },
    });
    const template = user?.onboardingTemplateId ? templateById(user.onboardingTemplateId) : undefined;
    const fromTemplate = template ? documentsFor(template).find((row) => row.surface === surface)?.document : undefined;
    const document = fromTemplate ?? (surface === "board" ? { v: 1 as const, placements: [] } : defaultLayout(surface));
    const row = await prisma.widgetLayout.upsert({
      where: { userId_surface: { userId: request.userId, surface } },
      create: { userId: request.userId, surface, templateId: template?.id ?? null, document: document as object },
      update: { document: document as object, templateId: template?.id ?? null },
    });
    return { surface, document: row.document, templateId: row.templateId, source: "reset" as const, ignored: [] as string[] };
  });
}

async function readLayout(prisma: FastifyInstance["prisma"], userId: string, surface: LayoutSurface) {
  const saved = await prisma.widgetLayout.findUnique({ where: { userId_surface: { userId, surface } } });
  if (saved) {
    const clean = sanitizeLayout(surface, saved.document);
    return { surface, document: clean.document, templateId: saved.templateId, source: "saved" as const, ignored: clean.ignored };
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { onboardingTemplateId: true } });
  const template = user?.onboardingTemplateId ? templateById(user.onboardingTemplateId) : undefined;
  if (template) {
    const match = documentsFor(template).find((row) => row.surface === surface);
    const document = match?.document ?? { v: 1 as const, placements: [] };
    return { surface, document, templateId: template.id, source: "template" as const, ignored: [] as string[] };
  }
  return { surface, document: defaultLayout(surface), templateId: null, source: "default" as const, ignored: [] as string[] };
}
