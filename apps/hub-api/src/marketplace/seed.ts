import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { PageDocument } from "@ensemble/shared-types";
import type { MarketTemplate } from "@ensemble/shared-types/marketplace";
import { zonedParts } from "../lib/clock.js";
import { pageSearchText } from "../pages/markdown.js";

type Db = Prisma.TransactionClient;

export function marketSourceRef(templateId: string, slug: string): string {
  return `mkt:${templateId}:${slug}`;
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

/** Inserts starter rows once. A slug already in the trash is left there. */
export async function seedMarketplace(db: Db, userId: string, template: MarketTemplate, timeZone: string): Promise<number> {
  const today = zonedParts(timeZone).date;
  const ref = (slug: string) => marketSourceRef(template.id, slug);
  let created = 0;

  for (const starter of template.starters) {
    const existingProject = await db.project.findFirst({ where: { userId, name: starter.name } });
    const project =
      existingProject ??
      (await db.project.create({
        data: { userId, name: starter.name, summary: starter.summary ?? "", createdBy: "me", confidence: 1 },
      }));
    if (!existingProject) created += 1;

    const personIds: string[] = [];
    const personBySlug = new Map<string, string>();
    for (const person of starter.people ?? []) {
      const upn = ref(person.slug);
      const existing = await db.person.findFirst({
        where: { userId, OR: [{ upn }, { name: person.name, deletedAt: null }] },
      });
      const row =
        existing ??
        (await db.person.create({
          data: { userId, upn, name: person.name, email: null, role: person.role ?? null, confidence: 1 },
        }));
      if (existing && person.role && !existing.role) await db.person.update({ where: { id: existing.id }, data: { role: person.role } });
      if (!existing) created += 1;
      personIds.push(row.id);
      personBySlug.set(person.slug, row.id);
      await db.projectPerson.upsert({
        where: { projectId_personId: { projectId: project.id, personId: row.id } },
        create: { projectId: project.id, personId: row.id, addedBy: "me" },
        update: {},
      });
    }

    const taskIds = new Map<string, string>();
    let taskIndex = 0;
    for (const task of starter.tasks ?? []) {
      const sourceRef = ref(task.slug);
      const existing = await db.task.findFirst({
        where: { userId, OR: [{ sourceRef }, { title: task.title, projectId: project.id }] },
      });
      if (existing) {
        taskIds.set(task.slug, existing.id);
        taskIndex += 1;
        continue;
      }
      const due = task.dueInDays === undefined ? null : new Date(`${addDays(today, task.dueInDays)}T00:00:00.000Z`);
      const row = await db.task.create({
        data: {
          userId,
          title: task.title,
          projectId: project.id,
          sourceKind: "manual",
          sourceRef,
          status: "todo",
          owner: "me",
          todayFocus: "keep",
          taskType: task.taskType,
          due,
          measure: task.measure ?? null,
          people: personIds.length ? [personIds[taskIndex % personIds.length]!] : [],
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
      taskIndex += 1;
    }

    if (template.layouts.today.placements.some((cell) => cell.type === "one-on-ones")) {
      for (let index = 0; index < personIds.length; index += 1) {
        const person = starter.people?.[index];
        const personId = personIds[index];
        if (!person || !personId) continue;
        const existing = await db.meetingNote.findFirst({ where: { userId, projectId: project.id, title: person.name } });
        if (existing) continue;
        await db.meetingNote.create({
          data: {
            userId,
            projectId: project.id,
            title: person.name,
            prompt: "What they are carrying this week.",
            answer: "",
            extraction: {},
            personIds: [personId],
            source: "paste",
            status: "ready",
          },
        });
        created += 1;
      }
    }

    const deliverableIds = new Map<string, string>();
    for (const item of starter.deliverables ?? []) {
      const sourceRef = ref(item.slug);
      const existing = await db.deliverable.findFirst({
        where: { userId, OR: [{ sourceRef }, { title: item.title, projectId: project.id }] },
      });
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
          due: item.dueInDays == null ? null : new Date(`${addDays(today, item.dueInDays)}T00:00:00.000Z`),
          createdBy: "me",
          status: "upcoming",
        },
      });
      deliverableIds.set(item.slug, row.id);
      created += 1;
    }

    for (const task of starter.tasks ?? []) {
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
      const kind = item.kind ?? "file";
      const existing = await db.artifact.findFirst({
        where: { userId, kind, OR: [{ externalId: sourceRef }, { title: item.title, projectId: project.id }] },
      });
      if (existing) continue;
      await db.artifact.create({
        data: {
          userId,
          kind,
          externalId: sourceRef,
          title: item.title,
          projectId: project.id,
          repoId,
          taskId: item.task ? (taskIds.get(item.task) ?? null) : null,
          ts: new Date(),
          text: "",
          metadata: { source: kind === "pr" ? "GitHub" : "Drive" },
        },
      });
      created += 1;
    }

    for (const note of starter.notes ?? []) {
      const existing = await db.meetingNote.findFirst({ where: { userId, projectId: project.id, title: note.title } });
      if (existing) continue;
      const named = (note.people ?? []).map((slug) => personBySlug.get(slug)).filter((id): id is string => Boolean(id));
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

    for (const item of starter.reminders ?? []) {
      const existing = await db.reminder.findFirst({ where: { userId, title: item.title } });
      if (existing) continue;
      await db.reminder.create({
        data: {
          userId,
          title: item.title,
          titleContent: docFromText(item.title),
          dueDate: addDays(today, item.dueInDays),
          timeZone,
          actionTokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        },
      });
      created += 1;
    }
  }

  return created;
}
