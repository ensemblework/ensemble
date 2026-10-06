import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { PageDocument } from "@ensemble/shared-types";
import { FULL_MODULE_SET } from "@ensemble/shared-types/modules";
import { templateByMarketId } from "@ensemble/shared-types/marketplace";
import { signupDeskId, templateById, type RoleTemplate } from "@ensemble/shared-types/templates";
import type { LayoutDocument, LayoutSurface } from "@ensemble/shared-types/widgets";
import { zonedParts } from "../lib/clock.js";
import { pageSearchText } from "../pages/markdown.js";
import { loadSettings, saveSettings } from "../lib/settings.js";

type Db = Prisma.TransactionClient;

export function templateSourceRef(templateId: string, slug: string): string {
  return `template:${templateId}:${slug}`;
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year!, (month ?? 1) - 1, day ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function docFromText(text: string) {
  const paragraphs = text.split(/\n{2,}/).map((block) => ({
    type: "paragraph",
    content: block
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => ({ type: "text", text: line })),
  }));
  return { type: "doc", content: paragraphs.length ? paragraphs : [{ type: "paragraph" }] };
}

export function documentsFor(template: RoleTemplate): Array<{ surface: LayoutSurface; document: LayoutDocument }> {
  const rows: Array<{ surface: LayoutSurface; document: LayoutDocument }> = [
    { surface: "today", document: template.today },
    { surface: "context", document: template.context },
  ];
  if (template.board) rows.push({ surface: "board", document: template.board });
  return rows;
}

/** Inserts starter rows once. A second call, including after trash, does not duplicate slugs. */
export async function seedTemplate(db: Db, userId: string, template: RoleTemplate, timeZone: string): Promise<number> {
  const today = zonedParts(timeZone).date;
  const starter = template.starter;
  const ref = (slug: string) => templateSourceRef(template.id, slug);
  let created = 0;

  const existingProject = await db.project.findFirst({ where: { userId, name: starter.project } });
  const project =
    existingProject ??
    (await db.project.create({
      data: { userId, name: starter.project, summary: starter.summary, createdBy: "me", confidence: 1 },
    }));
  if (!existingProject) created += 1;

  const personIds: string[] = [];
  const personByName = new Map<string, string>();
  for (const person of starter.people ?? []) {
    const upn = ref(person.slug);
    const existing = await db.person.findFirst({ where: { userId, upn } });
    const row =
      existing ??
      (await db.person.create({
        data: { userId, upn, name: person.name, email: null, role: person.role ?? null, confidence: 1 },
      }));
    if (existing && person.role && !existing.role) await db.person.update({ where: { id: existing.id }, data: { role: person.role } });
    if (!existing) created += 1;
    personIds.push(row.id);
    personByName.set(person.name.toLowerCase(), row.id);
    personByName.set(person.slug.toLowerCase(), row.id);
    await db.projectPerson.upsert({
      where: { projectId_personId: { projectId: project.id, personId: row.id } },
      create: { projectId: project.id, personId: row.id, addedBy: "me" },
      update: {},
    });
  }

  const taskIds = new Map<string, string>();
  for (const task of starter.tasks) {
    const sourceRef = ref(task.slug);
    const existing = await db.task.findFirst({ where: { userId, sourceRef } });
    if (existing) {
      taskIds.set(task.slug, existing.id);
      continue;
    }
    const proposed = task.status === "proposed";
    const row = await db.task.create({
      data: {
        userId,
        title: task.title,
        projectId: project.id,
        sourceKind: "manual",
        sourceRef,
        status: proposed ? "proposed" : "todo",
        owner: proposed ? "unassigned" : "me",
        todayFocus: proposed ? "auto" : "keep",
        taskType: starter.taskType,
        people: task.people ?? [],
        createdBy: "me",
        priority: "p1",
      },
    });
    taskIds.set(task.slug, row.id);
    created += 1;
    if (task.page) {
      const content = PageDocument.parse(docFromText(task.page));
      await db.taskPage.create({
        data: {
          userId,
          taskId: row.id,
          content: content as Prisma.InputJsonValue,
          searchText: pageSearchText(task.title, content, ""),
        },
      });
    }
  }

  const deliverableIds = new Map<string, string>();
  for (const item of starter.deliverables ?? []) {
    const sourceRef = ref(item.slug);
    const existing = await db.deliverable.findFirst({ where: { userId, sourceRef } });
    if (existing) {
      deliverableIds.set(item.slug, existing.id);
      continue;
    }
    const row = await db.deliverable.create({
      data: {
        userId,
        projectId: project.id,
        title: item.title,
        sourceRef,
        due: item.dueInDays === null ? null : new Date(`${addDays(today, item.dueInDays)}T00:00:00.000Z`),
        createdBy: "me",
        status: "upcoming",
      },
    });
    deliverableIds.set(item.slug, row.id);
    created += 1;
  }

  for (const task of starter.tasks) {
    const deliverableId = task.deliverable ? deliverableIds.get(task.deliverable) : undefined;
    const taskId = taskIds.get(task.slug);
    if (!deliverableId || !taskId) continue;
    await db.task.updateMany({ where: { id: taskId, userId, deliverableId: null }, data: { deliverableId } });
  }

  let repoId: string | null = null;
  if (starter.repo) {
    const existingRepo = await db.repo.findFirst({ where: { userId, fullName: starter.repo.fullName } });
    const repo =
      existingRepo ??
      (await db.repo.create({
        data: {
          userId,
          fullName: starter.repo.fullName,
          provider: "github",
          url: `https://github.com/${starter.repo.fullName}`,
          confidence: 1,
        },
      }));
    if (!existingRepo) created += 1;
    repoId = repo.id;
    await db.projectRepo.upsert({
      where: { projectId_repoId: { projectId: project.id, repoId: repo.id } },
      create: { projectId: project.id, repoId: repo.id, addedBy: "me" },
      update: {},
    });
  }

  for (const item of starter.artifacts ?? []) {
    const sourceRef = ref(item.slug);
    const existing = await db.artifact.findFirst({ where: { userId, externalId: sourceRef } });
    if (existing) continue;
    await db.artifact.create({
      data: {
        userId,
        kind: item.kind ?? "file",
        externalId: sourceRef,
        title: item.title,
        projectId: project.id,
        repoId,
        taskId: item.task ? (taskIds.get(item.task) ?? null) : null,
        ts: new Date(),
        text: "",
        metadata: { source: item.kind === "pr" ? "GitHub" : "Drive" },
      },
    });
    created += 1;
  }

  for (const item of starter.reminders ?? []) {
    const existing = await db.reminder.findFirst({ where: { userId, title: item.title } });
    if (existing) continue;
    await db.reminder.create({
      data: {
        userId,
        title: item.title,
        titleContent: docFromText(item.title),
        dueDate: addDays(today, item.dueInDays),
        dueTime: item.time ?? null,
        timeZone,
        actionTokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      },
    });
    created += 1;
  }

  for (const note of starter.notes ?? []) {
    const existing = await db.meetingNote.findFirst({ where: { userId, projectId: project.id, title: note.title } });
    if (existing) continue;
    const named = (note.people ?? []).map((name) => personByName.get(name.toLowerCase())).filter((id): id is string => Boolean(id));
    await db.meetingNote.create({
      data: {
        userId,
        projectId: project.id,
        title: note.title,
        prompt: note.body,
        answer: "",
        extraction: {},
        personIds: named.length ? named : personIds,
        source: "paste",
        status: "ready",
      },
    });
    created += 1;
  }

  return created;
}

export async function applyOnboarding(prisma: PrismaClient, userId: string, templateId: string): Promise<RoleTemplate> {
  const template = templateById(templateId);
  if (!template) throw Object.assign(new Error("Unknown template."), { statusCode: 400 });
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw Object.assign(new Error("Sign in."), { statusCode: 401 });
  if (user.onboardingCompletedAt) throw Object.assign(new Error("Onboarding is already finished."), { statusCode: 409 });
  const settings = await loadSettings(prisma, userId);
  await prisma.$transaction(async (tx) => {
    await seedTemplate(tx, userId, template, settings.timezone);
    for (const row of documentsFor(template)) {
      await tx.widgetLayout.upsert({
        where: { userId_surface: { userId, surface: row.surface } },
        create: { userId, surface: row.surface, templateId: template.id, document: row.document as object },
        update: { templateId: template.id, document: row.document as object },
      });
    }
    const marketId = signupDeskId(template.id);
    const market = marketId === "default" ? null : templateByMarketId(marketId);
    if (marketId !== "default" && !market) throw Object.assign(new Error("That desk is not in the catalog."), { statusCode: 500 });
    const modules = market ? [...market.modules].sort().join(",") : FULL_MODULE_SET;
    await tx.user.update({
      where: { id: userId },
      data: {
        onboardingRole: template.role,
        onboardingTemplateId: template.id,
        onboardingCompletedAt: new Date(),
        activeTemplateId: market?.id ?? "default",
        appliedVersion: market?.version ?? 1,
        moduleSet: modules,
        chromeLabels: (market?.labels ?? {}) as object,
        templateExpiresAt: null,
      },
    });
    await tx.session.updateMany({ where: { userId }, data: { modules } });
    const patch: Record<string, unknown> = { assistant: { actAs: market?.actAs ?? template.actAs } };
    if (market?.accent) patch.appearance = { accent: market.accent };
    await saveSettings(tx, userId, patch);
  });
  return template;
}
