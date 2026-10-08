/**
 * The Context DB (docs/03) — the Engineer Graph and everything linked to it.
 *
 * People, projects, repos, deliverables, skills and artifacts are nodes;
 * saved relationships and page @mentions are edges. Nothing here infers a
 * link from similarity: an edge exists because something recorded it.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { plotMentionEntities } from "../plots/mentions.js";
import type { FastifyInstance } from "fastify";
import { hasModule } from "@ensemble/shared-types";
import { appendLedger } from "../lib/ledger.js";
import { loadSettings } from "../lib/settings.js";
import { sseHub } from "../lib/sse.js";
import { arrange, CARD_CAP, emptyOrder, ORDER_KEY, OrderError, readOrder, sanitizeOrder, type LaneId, type OrderDocument } from "../context/order.js";
import { hidesSignupStarters } from "../marketplace/starters.js";
import { peopleCards } from "../context/people-view.js";
import { enrichDocument } from "../context/enrich-documents.js";
import { assertOwned } from "../services/records.js";
import { createCappedDocument } from "../lib/hosted-limits.js";
import { mirrorSettings } from "../spaces/store.js";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const HOSTED_PREFERENCE_PREFIX = "hosted.";

function assertEditablePreference(key: string): void {
  if (key.startsWith(HOSTED_PREFERENCE_PREFIX)) {
    throw Object.assign(new Error("Hosted usage is managed by Ensemble, not as an editable preference."), { statusCode: 403 });
  }
}

const DocumentTags = z.object({
  projectIds: z.array(z.string()).default([]),
  personIds: z.array(z.string()).default([]),
  repoIds: z.array(z.string()).default([]),
  taskIds: z.array(z.string()).default([]),
});

async function assertDocumentTags(db: FastifyInstance["prisma"], userId: string, tags: z.infer<typeof DocumentTags>): Promise<void> {
  for (const [key, kind] of [["projectIds", "project"], ["personIds", "person"], ["repoIds", "repo"], ["taskIds", "task"]] as const) {
    for (const id of tags[key]) await assertOwned(db, userId, kind, id);
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
  return letters || "?";
}

const WHEN = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

function stamp(value: Date): string {
  return WHEN.format(value);
}

function ago(value: Date): string {
  const days = Math.floor((Date.now() - value.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 14) return `${days} days ago`;
  return stamp(value);
}

function countLabel(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function dayMonth(value: Date): { day: string; month: string } {
  const parts = WHEN.formatToParts(value);
  return {
    day: parts.find((part) => part.type === "day")?.value ?? "",
    month: (parts.find((part) => part.type === "month")?.value ?? "").slice(0, 3).toUpperCase(),
  };
}
const TEXT_FORMATS = new Set(["md", "markdown", "txt", "csv", "json", "log", "yaml", "yml", "ts", "js", "py"]);

export async function contextRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  // ── people ──────────────────────────────────────────────────────────────

  app.get("/api/people", async (request) => {
    const userId = request.userId;
    const [people, tasks, notes, sessions] = await Promise.all([
      prisma.person.findMany({
        where: { userId, deletedAt: null },
        orderBy: [{ relationshipWeight: "desc" }, { name: "asc" }],
        include: { projects: { include: { project: { select: { id: true, name: true } } } } },
      }),
      prisma.task.findMany({
        where: { userId, deletedAt: null },
        select: { title: true, status: true, people: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 200,
      }),
      prisma.meetingNote.findMany({
        where: { userId, deletedAt: null },
        select: { title: true, personIds: true, askedAt: true },
        orderBy: { askedAt: "desc" },
        take: 40,
      }),
      prisma.meetingSession.findMany({
        where: { userId, deletedAt: null },
        select: { title: true, personIds: true, startedAt: true },
        orderBy: { startedAt: "desc" },
        take: 40,
      }),
    ]);
    return {
      people: peopleCards({
        people: people.map((person) => ({
          id: person.id,
          name: person.name,
          email: person.email,
          role: person.role,
          team: person.team,
          lastInteraction: person.lastInteraction?.toISOString() ?? null,
          confidence: person.confidence,
          projects: person.projects.map((link) => link.project),
        })),
        tasks: tasks.map((task) => ({
          title: task.title,
          status: task.status,
          people: task.people,
          updatedAt: task.updatedAt.toISOString(),
        })),
        notes: notes.map((note) => ({ title: note.title, personIds: note.personIds, askedAt: note.askedAt.toISOString() })),
        sessions: sessions.map((session) => ({ title: session.title, personIds: session.personIds, startedAt: session.startedAt.toISOString() })),
      }),
    };
  });

  app.post("/api/people", async (request, reply) => {
    const body = z
      .object({ name: z.string().min(1), email: z.string().email().optional(), role: z.string().optional() })
      .parse(request.body);
    const person = await prisma.person.create({
      data: { userId: request.userId, name: body.name, email: body.email, role: body.role, upn: body.email },
    });
    return reply.code(201).send({ person });
  });

  app.patch("/api/people/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        name: z.string().min(1).optional(),
        email: z.string().nullish(),
        role: z.string().nullish(),
        team: z.string().nullish(),
      })
      .parse(request.body);
    const found = await prisma.person.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!found) return reply.code(404).send({ error: "Person not found." });
    const person = await prisma.person.update({ where: { id }, data: body });
    sseHub.publish(request.userId, { event: "context", data: { kind: "people", id } });
    return { person };
  });

  app.delete("/api/people/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const person = await prisma.person.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!person) return reply.code(404).send({ error: "Person not found." });
    await prisma.$transaction([
      prisma.person.update({ where: { id }, data: { deletedAt: new Date() } }),
      prisma.contextSuppression.upsert({
        where: { userId_kind_key: { userId: request.userId, kind: "person", key: person.upn ?? person.name } },
        create: { userId: request.userId, kind: "person", key: person.upn ?? person.name, label: person.name },
        update: {},
      }),
    ]);
    await appendLedger({ userId: request.userId, actor: "me", action: "person.delete", payload: { id } });
    return reply.code(204).send();
  });

  // ── projects ────────────────────────────────────────────────────────────

  app.get("/api/projects", async (request) => {
    const projects = await prisma.project.findMany({
      where: { userId: request.userId, deletedAt: null },
      orderBy: [{ status: "asc" }, { name: "asc" }],
      include: {
        repoLinks: { include: { repo: { select: { id: true, fullName: true } } } },
        people: { include: { person: { select: { id: true, name: true } } } },
        _count: { select: { deliverables: { where: { deletedAt: null } }, tasks: { where: { deletedAt: null } } } },
      },
    });
    return {
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        summary: project.summary,
        status: project.status,
        aliases: project.aliases,
        repos: project.repoLinks.map((link) => link.repo),
        people: project.people.map((link) => link.person),
        deliverableCount: project._count.deliverables,
        taskCount: project._count.tasks,
      })),
    };
  });

  app.get("/api/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await prisma.project.findFirst({
      where: { id, userId: request.userId, deletedAt: null },
      include: {
        repoLinks: { include: { repo: true } },
        people: { include: { person: true } },
        deliverables: { where: { deletedAt: null }, orderBy: { due: "asc" } },
        tasks: { where: { deletedAt: null }, orderBy: { boardOrder: "asc" }, take: 50 },
        meetingNotes: { where: { deletedAt: null }, orderBy: { askedAt: "desc" }, take: 20 },
      },
    });
    if (!project) return reply.code(404).send({ error: "Project not found." });
    return { project };
  });

  app.post("/api/projects", async (request, reply) => {
    const body = z.object({ name: z.string().min(1), summary: z.string().optional() }).parse(request.body);
    const project = await prisma.project.create({
      data: { userId: request.userId, name: body.name, summary: body.summary ?? "", createdBy: "me" },
    });
    sseHub.publish(request.userId, { event: "context", data: { kind: "project", id: project.id } });
    return reply.code(201).send({ project });
  });

  app.patch("/api/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        name: z.string().min(1).optional(),
        summary: z.string().optional(),
        notes: z.string().optional(),
        status: z.enum(["active", "done"]).optional(),
        personIds: z.array(z.string().uuid()).optional(),
        repoIds: z.array(z.string().uuid()).optional(),
      })
      .parse(request.body);
    const found = await prisma.project.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!found) return reply.code(404).send({ error: "Project not found." });
    const { personIds, repoIds, ...data } = body;
    await prisma.$transaction(async (tx) => {
      for (const personId of personIds ?? []) await assertOwned(tx, request.userId, "person", personId);
      for (const repoId of repoIds ?? []) await assertOwned(tx, request.userId, "repo", repoId);
      await tx.project.update({
        where: { id },
        data: { ...data, completedAt: data.status === "done" ? new Date() : data.status === "active" ? null : undefined },
      });
      if (personIds) {
        await tx.projectPerson.deleteMany({ where: { projectId: id } });
        await tx.projectPerson.createMany({ data: personIds.map((personId) => ({ projectId: id, personId, addedBy: "me" })) });
      }
      if (repoIds) {
        await tx.projectRepo.deleteMany({ where: { projectId: id } });
        await tx.projectRepo.createMany({ data: repoIds.map((repoId) => ({ projectId: id, repoId, addedBy: "me" })) });
      }
    });
    sseHub.publish(request.userId, { event: "context", data: { kind: "project", id } });
    return { ok: true };
  });

  app.delete("/api/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await prisma.project.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!project) return reply.code(404).send({ error: "Project not found." });
    await prisma.$transaction([
      prisma.project.update({ where: { id }, data: { deletedAt: new Date() } }),
      prisma.contextSuppression.upsert({
        where: { userId_kind_key: { userId: request.userId, kind: "project", key: project.name } },
        create: { userId: request.userId, kind: "project", key: project.name, label: project.name },
        update: {},
      }),
    ]);
    await appendLedger({ userId: request.userId, actor: "me", action: "project.delete", payload: { id } });
    return reply.code(204).send();
  });

  // ── repos ───────────────────────────────────────────────────────────────

  app.get("/api/repos", async (request) => {
    const repos = await prisma.repo.findMany({
      where: { userId: request.userId, deletedAt: null },
      orderBy: [{ tracked: "desc" }, { fullName: "asc" }],
      include: { projects: { include: { project: { select: { id: true, name: true } } } } },
    });
    return {
      repos: repos.map((repo) => ({
        id: repo.id,
        fullName: repo.fullName,
        provider: repo.provider,
        url: repo.url,
        description: repo.description,
        defaultBranch: repo.defaultBranch,
        tracked: repo.tracked,
        myRole: repo.myRole,
        languages: repo.languages,
        lastSyncedAt: repo.lastSyncedAt?.toISOString() ?? null,
        projects: repo.projects.map((link) => link.project),
      })),
    };
  });

  app.post("/api/repos", async (request, reply) => {
    const body = z.object({ fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/), tracked: z.boolean().default(true) }).parse(request.body);
    const repo = await prisma.repo.upsert({
      where: { userId_fullName: { userId: request.userId, fullName: body.fullName } },
      create: {
        userId: request.userId,
        fullName: body.fullName,
        tracked: body.tracked,
        url: `https://github.com/${body.fullName}`,
      },
      update: { tracked: body.tracked, deletedAt: null },
    });
    return reply.code(201).send({ repo });
  });

  app.delete("/api/repos/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { softDelete } = await import("../services/records.js");
    try {
      const result = await prisma.$transaction((tx) => softDelete(tx, request.userId, "repo", id, "me"));
      sseHub.publish(request.userId, { event: "context", data: { id } });
      return { ok: true, label: result.label };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : "Repo not found." });
    }
  });

  app.patch("/api/repos/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ tracked: z.boolean().optional(), description: z.string().nullish() }).parse(request.body);
    const result = await prisma.repo.updateMany({ where: { id, userId: request.userId, deletedAt: null }, data: body });
    if (!result.count) return reply.code(404).send({ error: "Repo not found." });
    return { ok: true };
  });

  // ── preferences (learned + declared; settings live under hub.* keys) ────

  app.get("/api/preferences", async (request) => {
    const preferences = await prisma.preference.findMany({
      where: {
        userId: request.userId,
        deletedAt: null,
        NOT: [{ key: { startsWith: "hub." } }, { key: { startsWith: HOSTED_PREFERENCE_PREFIX } }],
      },
      orderBy: { key: "asc" },
    });
    return { preferences };
  });

  app.put("/api/preferences/:key", async (request, reply) => {
    const { key } = request.params as { key: string };
    assertEditablePreference(key);
    // Settings save through PATCH /api/settings, which checks what they hold (Code folders, for one).
    if (key === "hub.settings") return reply.code(400).send({ error: "Settings are saved from the Settings page, not as a preference." });
    const body = z.object({ value: z.unknown() }).parse(request.body);
    const preference = await prisma.preference.upsert({
      where: { userId_key: { userId: request.userId, key } },
      create: { userId: request.userId, key, value: body.value as never, source: "me", confidence: 1 },
      update: { value: body.value as never, source: "me", confidence: 1, deletedAt: null },
    });
    if (key.startsWith("ui.")) await mirrorSettings(prisma, request.userId);
    return { preference };
  });

  app.delete("/api/preferences/:key", async (request, reply) => {
    const { key } = request.params as { key: string };
    assertEditablePreference(key);
    await prisma.preference.updateMany({ where: { userId: request.userId, key }, data: { deletedAt: new Date() } });
    if (key.startsWith("ui.")) await mirrorSettings(prisma, request.userId);
    return reply.code(204).send();
  });

  // ── board (lanes, manual order, no undo) ────────────────────────────────

  app.get("/api/context/board", async (request) => {
    const userId = request.userId;
    const hideStarters = await hidesSignupStarters(prisma, userId);
    const starterTask = hideStarters ? { NOT: { sourceRef: { startsWith: "template:" } } } : {};
    const starterPerson = hideStarters ? { OR: [{ upn: null }, { NOT: { upn: { startsWith: "template:" } } }] } : {};
    const starterDeliverable = hideStarters
      ? { OR: [{ sourceRef: null }, { NOT: { sourceRef: { startsWith: "template:" } } }] }
      : {};
    const [people, projects, repos, notes, artifacts, deliverables, tasks, taskCounts, pref] = await Promise.all([
      prisma.person.findMany({
        where: { userId, deletedAt: null, ...starterPerson },
        orderBy: [{ relationshipWeight: "desc" }, { name: "asc" }],
        include: { projects: { include: { project: { select: { id: true, name: true } } } } },
        take: CARD_CAP,
      }),
      prisma.project.findMany({
        where: { userId, deletedAt: null },
        orderBy: [{ status: "asc" }, { name: "asc" }],
        include: {
          repoLinks: { include: { repo: { select: { id: true, fullName: true } } } },
          people: { include: { person: { select: { id: true, name: true } } } },
          _count: { select: { deliverables: { where: { deletedAt: null } }, tasks: { where: { deletedAt: null } } } },
        },
        take: CARD_CAP,
      }),
      prisma.repo.findMany({
        where: { userId, deletedAt: null },
        orderBy: [{ tracked: "desc" }, { fullName: "asc" }],
        include: { projects: { include: { project: { select: { id: true, name: true } } } } },
        take: CARD_CAP,
      }),
      prisma.meetingNote.findMany({
        where: { userId, deletedAt: null },
        orderBy: { askedAt: "desc" },
        take: CARD_CAP,
        select: { id: true, title: true, askedAt: true, projectId: true, personIds: true },
      }),
      prisma.artifact.findMany({
        where: { userId, deletedAt: null },
        orderBy: { ts: "desc" },
        take: CARD_CAP,
        select: { id: true, kind: true, title: true, ts: true, projectId: true, repoId: true, url: true },
      }),
      prisma.deliverable.findMany({
        where: { userId, deletedAt: null, ...starterDeliverable },
        orderBy: [{ due: "asc" }, { title: "asc" }],
        take: CARD_CAP,
        select: { id: true, title: true, status: true, due: true, projectId: true, updatedAt: true },
      }),
      prisma.task.findMany({
        where: { userId, deletedAt: null, ...starterTask },
        orderBy: { updatedAt: "desc" },
        take: 80,
        select: { id: true, title: true, status: true, projectId: true, repoId: true, people: true, updatedAt: true },
      }),
      prisma.task.groupBy({
        by: ["projectId", "status"],
        where: { userId, deletedAt: null, projectId: { not: null }, ...starterTask },
        _count: { _all: true },
      }),
      prisma.preference.findFirst({ where: { userId, key: ORDER_KEY, deletedAt: null }, select: { value: true } }),
    ]);
    const order = readOrder(pref?.value ?? emptyOrder());
    const projectName = new Map(projects.map((project) => [project.id, project.name]));
    const personName = new Map(people.map((person) => [person.id, person.name]));
    const blank = {
      progress: null as { done: number; total: number } | null,
      members: [] as string[],
      language: null as string | null,
      day: null as string | null,
      month: null as string | null,
      activity: [] as Array<{ id: string; title: string; when: string }>,
      href: null as string | null,
    };
    const activityFor = (match: (task: (typeof tasks)[number]) => boolean) =>
      tasks
        .filter(match)
        .slice(0, 6)
        .map((task) => ({ id: task.id, title: task.title, when: ago(task.updatedAt) }));
    const peopleCards = people.map((person) => ({
      ...blank,
      id: person.id,
      lane: "people" as const,
      kind: "people" as const,
      title: person.name,
      subtitle: person.role || person.team || null,
      meta: person.lastInteraction ? ago(person.lastInteraction) : null,
      initials: initials(person.name),
      chips: person.projects.slice(0, 2).map((link) => link.project.name),
      projectIds: person.projects.map((link) => link.project.id),
      personIds: [] as string[],
      repoIds: [] as string[],
      artifactKind: null as string | null,
      activity: activityFor((task) => task.people.includes(person.id)),
    }));
    const doneByProject = new Map<string, number>();
    for (const row of taskCounts) {
      if (!row.projectId || row.status !== "done") continue;
      doneByProject.set(row.projectId, row._count._all);
    }
    const projectCards = projects.map((project) => {
      return {
        ...blank,
        id: project.id,
        lane: "projects" as const,
        kind: "project" as const,
        title: project.name,
        subtitle: project.summary ? project.summary.slice(0, 140) : null,
        meta: `${countLabel(project._count.tasks, "task")} · ${countLabel(project._count.deliverables, "deliverable")}`,
        initials: initials(project.name),
        chips: project.repoLinks.slice(0, 2).map((link) => link.repo.fullName),
        projectIds: [project.id],
        personIds: project.people.map((link) => link.person.id),
        repoIds: project.repoLinks.map((link) => link.repo.id),
        artifactKind: null,
        progress: { done: doneByProject.get(project.id) ?? 0, total: project._count.tasks },
        members: project.people.slice(0, 4).map((link) => initials(link.person.name)),
        activity: activityFor((task) => task.projectId === project.id),
      };
    });
    const repoCards = repos.map((repo) => {
      const [owner, name] = repo.fullName.includes("/") ? repo.fullName.split("/", 2) : ["", repo.fullName];
      const when = repo.lastSyncedAt ? dayMonth(repo.lastSyncedAt) : null;
      return {
        ...blank,
        id: repo.id,
        lane: "repos" as const,
        kind: "repo" as const,
        title: name || repo.fullName,
        subtitle: owner && owner !== name ? owner : null,
        meta: repo.lastSyncedAt ? `Synced ${ago(repo.lastSyncedAt)}` : null,
        href: repo.url || `https://github.com/${repo.fullName}`,
        initials: initials(name || repo.fullName),
        chips: repo.projects.slice(0, 2).map((link) => link.project.name),
        projectIds: repo.projects.map((link) => link.project.id),
        personIds: [] as string[],
        repoIds: [] as string[],
        artifactKind: null,
        language: repo.languages[0] || null,
        day: when?.day ?? null,
        month: when?.month ?? null,
        activity: activityFor((task) => task.repoId === repo.id),
      };
    });
    const meetingCards = notes.map((note) => {
      const when = dayMonth(note.askedAt);
      return {
        ...blank,
        id: note.id,
        lane: "meetings" as const,
        kind: "meeting" as const,
        title: note.title || "Meeting",
        subtitle: note.personIds.map((id) => personName.get(id)).filter(Boolean).slice(0, 3).join(", ") || null,
        meta: ago(note.askedAt),
        initials: "M",
        chips: note.projectId && projectName.get(note.projectId) ? [projectName.get(note.projectId)!] : [],
        projectIds: note.projectId ? [note.projectId] : [],
        personIds: note.personIds,
        repoIds: [] as string[],
        artifactKind: null,
        day: when.day,
        month: when.month,
      };
    });
    const deliverableCards = deliverables.map((row) => {
      const when = row.due ? dayMonth(row.due) : dayMonth(row.updatedAt);
      return {
        ...blank,
        id: row.id,
        lane: "artifacts" as const,
        kind: "artifact" as const,
        title: row.title,
        subtitle: "Deliverable",
        meta: row.due ? `Due ${stamp(row.due)}` : row.status,
        initials: "D",
        chips: row.projectId && projectName.get(row.projectId) ? [projectName.get(row.projectId)!] : [],
        projectIds: row.projectId ? [row.projectId] : [],
        personIds: [] as string[],
        repoIds: [] as string[],
        artifactKind: "deliverable",
        day: when.day,
        month: when.month,
        href: `/today?deliverable=${row.id}`,
      };
    });
    const artifactCards = [
      ...deliverableCards,
      ...artifacts.map((artifact) => {
        const when = dayMonth(artifact.ts);
        return {
          ...blank,
          id: artifact.id,
          lane: "artifacts" as const,
          kind: "artifact" as const,
          title: artifact.title || artifact.kind,
          subtitle: artifact.kind.replaceAll("_", " "),
          meta: ago(artifact.ts),
          initials: artifact.kind.slice(0, 1).toUpperCase(),
          chips: artifact.projectId && projectName.get(artifact.projectId) ? [projectName.get(artifact.projectId)!] : [],
          projectIds: artifact.projectId ? [artifact.projectId] : [],
          personIds: [] as string[],
          repoIds: artifact.repoId ? [artifact.repoId] : [],
          artifactKind: artifact.kind,
          day: when.day,
          month: when.month,
          href: artifact.url || null,
        };
      }),
    ].slice(0, CARD_CAP);
    const lanes = [
      { id: "people" as const, label: "People", cards: arrange(peopleCards, order.lanes.people) },
      { id: "projects" as const, label: "Projects", cards: arrange(projectCards, order.lanes.projects) },
      { id: "repos" as const, label: "Repos", cards: arrange(repoCards, order.lanes.repos) },
      { id: "meetings" as const, label: "Meetings", cards: arrange(meetingCards, order.lanes.meetings) },
      { id: "artifacts" as const, label: "Artifacts", cards: arrange(artifactCards, order.lanes.artifacts) },
    ];
    return { view: order.view, group: order.group, groups: order.groups, kinds: order.kinds ?? null, lanes };
  });

  app.put("/api/context/order", async (request, reply) => {
    const userId = request.userId;
    const before = await prisma.undoEntry.count({ where: { userId } });
    const [people, projects, repos, notes, artifacts, deliverables, tasks] = await Promise.all([
      prisma.person.findMany({ where: { userId, deletedAt: null }, select: { id: true } }),
      prisma.project.findMany({ where: { userId, deletedAt: null }, select: { id: true } }),
      prisma.repo.findMany({ where: { userId, deletedAt: null }, select: { id: true } }),
      prisma.meetingNote.findMany({ where: { userId, deletedAt: null }, select: { id: true }, take: 200 }),
      prisma.artifact.findMany({ where: { userId, deletedAt: null }, select: { id: true }, take: 200 }),
      prisma.deliverable.findMany({ where: { userId, deletedAt: null }, select: { id: true }, take: 200 }),
      prisma.task.findMany({ where: { userId, deletedAt: null }, select: { id: true }, take: 400 }),
    ]);
    const owned: Record<LaneId, Set<string>> = {
      people: new Set(people.map((row) => row.id)),
      projects: new Set(projects.map((row) => row.id)),
      repos: new Set(repos.map((row) => row.id)),
      meetings: new Set(notes.map((row) => row.id)),
      artifacts: new Set([...artifacts.map((row) => row.id), ...deliverables.map((row) => row.id)]),
    };
    let next: OrderDocument;
    try {
      next = sanitizeOrder(request.body, owned, new Set(tasks.map((row) => row.id)));
      const body = request.body as { kinds?: unknown };
      if (!Array.isArray(body?.kinds)) {
        const existing = await prisma.preference.findFirst({ where: { userId, key: ORDER_KEY, deletedAt: null } });
        const previous = existing ? readOrder(existing.value) : null;
        if (previous?.kinds) next = { ...next, kinds: previous.kinds };
      }
    } catch (error) {
      if (error instanceof OrderError) return reply.code(400).send({ error: error.message });
      throw error;
    }
    await prisma.preference.upsert({
      where: { userId_key: { userId, key: ORDER_KEY } },
      create: { userId, key: ORDER_KEY, value: next as never, source: "me", confidence: 1 },
      update: { value: next as never, source: "me", confidence: 1, deletedAt: null },
    });
    const after = await prisma.undoEntry.count({ where: { userId } });
    if (after !== before) throw new Error("Context order must stay off the undo stack.");
    return { ok: true, order: next };
  });

  // ── artifacts (normalized items from every source) ──────────────────────

  app.get("/api/artifacts", async (request) => {
    const query = z
      .object({ kind: z.string().optional(), q: z.string().optional(), take: z.coerce.number().default(60) })
      .parse(request.query);
    const artifacts = await prisma.artifact.findMany({
      where: {
        userId: request.userId,
        deletedAt: null,
        ...(query.kind ? { kind: query.kind as never } : {}),
        ...(query.q
          ? { OR: [{ title: { contains: query.q, mode: "insensitive" } }, { text: { contains: query.q, mode: "insensitive" } }] }
          : {}),
      },
      orderBy: { ts: "desc" },
      take: Math.min(query.take, 200),
      select: { id: true, kind: true, title: true, url: true, ts: true, projectId: true, repoId: true, taskId: true, metadata: true },
    });
    const counts = await prisma.artifact.groupBy({
      by: ["kind"],
      where: { userId: request.userId, deletedAt: null },
      _count: true,
    });
    const sync = await prisma.syncState.findMany({ where: { userId: request.userId } });
    return {
      artifacts,
      counts: counts.map((row) => ({ kind: row.kind, count: row._count })),
      sync,
    };
  });

  // ── document library ────────────────────────────────────────────────────

  app.get("/api/documents", async (request) => {
    const { q } = request.query as { q?: string };
    const documents = await prisma.document.findMany({
      where: {
        userId: request.userId,
        deletedAt: null,
        ...(q ? { filename: { contains: q, mode: "insensitive" } } : {}),
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        filename: true,
        mediaType: true,
        byteSize: true,
        format: true,
        parseStatus: true,
        enrichmentStatus: true,
        textCharacters: true,
        summary: true,
        enrichmentError: true,
        sha256: true,
        createdAt: true,
        parsedAt: true,
        manualTags: true,
        projectIds: true,
        personIds: true,
        repoIds: true,
        taskIds: true,
        warnings: true,
        modelUsage: true,
      },
    });
    return { documents };
  });

  app.post(
    "/api/documents",
    { bodyLimit: Math.ceil(MAX_UPLOAD_BYTES * 1.4) },
    async (request, reply) => {
      const body = z
        .object({
          filename: z.string().min(1).max(255),
          mediaType: z.string().default("application/octet-stream"),
          dataBase64: z.string(),
          summarize: z.boolean().default(true),
          tags: DocumentTags.default({}),
        })
        .parse(request.body);
      await assertDocumentTags(prisma, request.userId, body.tags);
      const original = Buffer.from(body.dataBase64, "base64");
      if (original.byteLength > MAX_UPLOAD_BYTES) {
        return reply.code(413).send({ error: "Files are limited to 20 MiB." });
      }
      const format = (body.filename.split(".").pop() ?? "").toLowerCase();
      const isText = TEXT_FORMATS.has(format) || body.mediaType.startsWith("text/");
      const text = isText ? original.toString("utf8") : "";
      const document = await createCappedDocument(prisma, request.userId, {
        data: {
          userId: request.userId,
          filename: body.filename,
          mediaType: body.mediaType,
          byteSize: original.byteLength,
          sha256: createHash("sha256").update(original).digest("hex"),
          original,
          format,
          parseStatus: isText ? "ready" : "queued",
          parserVersion: "ensemble-documents/1",
          textCharacters: text.length,
          parsedAt: isText ? new Date() : null,
          enrichmentStatus: body.summarize ? "queued" : "skipped",
          warnings: isText ? [] : ["Binary formats (DOCX, PPTX, PDF) are parsed by the context worker when it runs."],
          ...body.tags,
          manualTags: body.tags,
          artifact: isText
            ? {
                create: {
                  userId: request.userId,
                  kind: "file",
                  externalId: `upload:${createHash("sha1").update(original).digest("hex")}`,
                  ts: new Date(),
                  title: body.filename,
                  text: text.slice(0, 200_000),
                  authoredByMe: true,
                },
              }
            : undefined,
        },
        select: { id: true, filename: true, parseStatus: true },
      });
      await appendLedger({
        userId: request.userId,
        actor: "me",
        action: "document.upload",
        payload: { id: document.id, filename: body.filename, bytes: original.byteLength },
      });
      if (body.summarize) {
        void enrichDocument(app, document.id).catch((error: unknown) => app.log.error({ err: error }, "document summary failed"));
      }
      return reply.code(201).send({ document });
    },
  );

  app.get("/api/documents/:id/text", async (request, reply) => {
    const { id } = request.params as { id: string };
    const document = await prisma.document.findFirst({
      where: { id, userId: request.userId, deletedAt: null },
      include: { artifact: { select: { text: true } } },
    });
    if (!document) return reply.code(404).send({ error: "Document not found." });
    return { text: document.artifact?.text ?? "" };
  });

  app.get("/api/documents/:id/original", async (request, reply) => {
    const { id } = request.params as { id: string };
    const document = await prisma.document.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!document) return reply.code(404).send({ error: "Document not found." });
    reply.header("Content-Type", document.mediaType);
    reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(document.filename)}"`);
    return reply.send(Buffer.from(document.original));
  });

  app.patch("/api/documents/:id/tags", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = DocumentTags.parse(request.body);
    const found = await prisma.document.findFirst({ where: { id, userId: request.userId, deletedAt: null }, select: { id: true } });
    if (!found) return reply.code(404).send({ error: "Document not found." });
    await assertDocumentTags(prisma, request.userId, body);
    await prisma.document.updateMany({
      where: { id, userId: request.userId, deletedAt: null },
      data: { ...body, manualTags: body },
    });
    return { ok: true };
  });

  app.delete("/api/documents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await prisma.document.updateMany({ where: { id, userId: request.userId, deletedAt: null }, data: { deletedAt: new Date() } });
    if (!result.count) return reply.code(404).send({ error: "Document not found." });
    return reply.code(204).send();
  });

  // ── @mention entities ───────────────────────────────────────────────────

  app.get("/api/entities", async (request) => {
    const userId = request.userId;
    const [people, projects, repos, tasks, deliverables, skills, diagrams, plots, datasets] = await Promise.all([
      prisma.person.findMany({ where: { userId, deletedAt: null }, select: { id: true, name: true, email: true }, take: 300 }),
      prisma.project.findMany({ where: { userId, deletedAt: null }, select: { id: true, name: true }, take: 200 }),
      prisma.repo.findMany({ where: { userId, deletedAt: null }, select: { id: true, fullName: true }, take: 200 }),
      prisma.task.findMany({
        where: { userId, deletedAt: null, status: { not: "dropped" } },
        select: { id: true, title: true, status: true },
        orderBy: { updatedAt: "desc" },
        take: 300,
      }),
      prisma.deliverable.findMany({ where: { userId, deletedAt: null }, select: { id: true, title: true }, take: 200 }),
      hasModule(request.modules, "skills")
        ? prisma.skill.findMany({ where: { userId, deletedAt: null }, select: { id: true, name: true }, take: 100 })
        : Promise.resolve([]),
      hasModule(request.modules, "diagrams")
        ? prisma.blockDiagram.findMany({ where: { userId, deletedAt: null }, select: { id: true, title: true }, orderBy: { updatedAt: "desc" }, take: 100 })
        : Promise.resolve([]),
      hasModule(request.modules, "plots")
        ? prisma.plot.findMany({ where: { userId, deletedAt: null }, select: { id: true, title: true, config: true }, orderBy: { updatedAt: "desc" }, take: 100 })
        : Promise.resolve([]),
      hasModule(request.modules, "plots")
        ? prisma.plotDataset.findMany({ where: { userId, deletedAt: null }, select: { id: true, name: true, format: true }, orderBy: { updatedAt: "desc" }, take: 100 })
        : Promise.resolve([]),
    ]);
    return {
      entities: [
        ...people.map((row) => ({ kind: "people", id: row.id, label: row.name, detail: row.email ?? "" })),
        ...projects.map((row) => ({ kind: "project", id: row.id, label: row.name, detail: "" })),
        ...repos.map((row) => ({ kind: "repo", id: row.id, label: row.fullName, detail: "" })),
        ...tasks.map((row) => ({ kind: "task", id: row.id, label: row.title, detail: row.status })),
        ...deliverables.map((row) => ({ kind: "deliverable", id: row.id, label: row.title, detail: "" })),
        ...skills.map((row) => ({ kind: "skill", id: row.id, label: row.name, detail: "" })),
        ...diagrams.map((row) => ({ kind: "diagram", id: row.id, label: row.title, detail: "" })),
        ...plotMentionEntities(plots, datasets),
      ],
    };
  });

  // ── the graph ───────────────────────────────────────────────────────────

  app.get("/api/context/graph", async (request) => {
    const { includeCompleted } = request.query as { includeCompleted?: string };
    const userId = request.userId;
    const recentDone = includeCompleted === "true";
    const settings = await loadSettings(prisma, userId);
    const reviewDays = settings.contextReviewDays;
    const reviewSince = new Date(Date.now() - reviewDays * 86_400_000);
    const [people, projects, repos, tasks, deliverables, skills, projectPeople, projectRepos, mentions, notes, diagrams, diagramLinks, plots, artifacts, sessions, documents] =
      await Promise.all([
        prisma.person.findMany({ where: { userId, deletedAt: null }, select: { id: true, name: true, role: true } }),
        prisma.project.findMany({ where: { userId, deletedAt: null }, select: { id: true, name: true, status: true } }),
        prisma.repo.findMany({ where: { userId, deletedAt: null }, select: { id: true, fullName: true } }),
        prisma.task.findMany({
          where: {
            userId,
            deletedAt: null,
            OR: [
              { status: { notIn: ["done", "dropped"] } },
              ...(recentDone
                ? [{ status: "done" as const }]
                : reviewDays > 0
                  ? [{ status: "done" as const, completedAt: { gte: reviewSince } }]
                  : []),
            ],
          },
          select: { id: true, title: true, status: true, projectId: true, repoId: true, deliverableId: true, people: true, skillIds: true, completedAt: true, dependsOn: true },
          orderBy: { updatedAt: "desc" },
          take: 200,
        }),
        prisma.deliverable.findMany({
          where: { userId, deletedAt: null, ...(recentDone ? {} : { status: "upcoming" }) },
          select: { id: true, title: true, status: true, projectId: true },
        }),
        hasModule(request.modules, "skills")
          ? prisma.skill.findMany({ where: { userId, deletedAt: null, enabled: true }, select: { id: true, name: true } })
          : Promise.resolve([]),
        prisma.projectPerson.findMany({ where: { project: { userId } }, select: { projectId: true, personId: true } }),
        prisma.projectRepo.findMany({ where: { project: { userId } }, select: { projectId: true, repoId: true } }),
        prisma.taskPageMention.findMany({
          where: { page: { userId } },
          select: { kind: true, entityId: true, page: { select: { taskId: true } } },
        }),
        prisma.meetingNote.findMany({
          where: { userId, deletedAt: null },
          select: { id: true, title: true, projectId: true, repoId: true, personIds: true },
          take: 60,
          orderBy: { askedAt: "desc" },
        }),
        hasModule(request.modules, "diagrams")
          ? prisma.blockDiagram.findMany({ where: { userId, deletedAt: null }, select: { id: true, title: true }, take: 80 })
          : Promise.resolve([]),
        hasModule(request.modules, "diagrams")
          ? prisma.diagramLink.findMany({
              where: { userId, diagram: { deletedAt: null } },
              select: { diagramId: true, targetId: true },
              take: 200,
            })
          : Promise.resolve([]),
        hasModule(request.modules, "plots")
          ? prisma.plot.findMany({ where: { userId, deletedAt: null }, select: { id: true, title: true }, take: 80 })
          : Promise.resolve([]),
        prisma.artifact.findMany({
          where: { userId, deletedAt: null },
          select: { id: true, title: true, kind: true, projectId: true, repoId: true, taskId: true },
          orderBy: { ts: "desc" },
          take: 80,
        }),
        prisma.meetingSession.findMany({
          where: { userId, deletedAt: null },
          select: { personIds: true, artifactId: true, meetingNoteId: true },
          orderBy: { startedAt: "desc" },
          take: 40,
        }),
        prisma.document.findMany({
          where: { userId, deletedAt: null, artifactId: { not: null } },
          select: { artifactId: true, projectIds: true, personIds: true, taskIds: true, repoIds: true, deliverableIds: true },
          take: 40,
        }),
      ]);

    const nodes = [
      ...people.map((row) => ({ id: row.id, kind: "people", label: row.name, sub: row.role ?? "people" })),
      ...projects.map((row) => ({ id: row.id, kind: "project", label: row.name, sub: `project · ${row.status}` })),
      ...repos.map((row) => ({ id: row.id, kind: "repo", label: row.fullName, sub: "repo" })),
      ...tasks.map((row) => ({ id: row.id, kind: "task", label: row.title, sub: `task · ${row.status.replace("_", " ")}` })),
      ...deliverables.map((row) => ({ id: row.id, kind: "deliverable", label: row.title, sub: `deliverable · ${row.status}` })),
      ...skills.map((row) => ({ id: row.id, kind: "skill", label: row.name, sub: "skill" })),
      ...notes.map((row) => ({ id: row.id, kind: "note", label: row.title, sub: "meeting note" })),
      ...diagrams.map((row) => ({ id: row.id, kind: "diagram", label: row.title, sub: "diagram" })),
      ...plots.map((row) => ({ id: row.id, kind: "plot", label: row.title, sub: "plot" })),
      ...artifacts.map((row) => ({ id: row.id, kind: "artifact", label: row.title || "Untitled artifact", sub: `artifact · ${row.kind.replaceAll("_", " ")}` })),
    ];
    const ids = new Set(nodes.map((node) => node.id));
    const byName = new Map(people.map((row) => [row.name.toLowerCase(), row.id]));
    const edges: Array<{ source: string; target: string; kind: string }> = [];
    const link = (source: string | null | undefined, target: string | null | undefined, kind: string) => {
      if (source && target && ids.has(source) && ids.has(target)) edges.push({ source, target, kind });
    };
    for (const row of projectPeople) link(row.personId, row.projectId, "member");
    for (const row of projectRepos) link(row.projectId, row.repoId, "repo");
    for (const task of tasks) {
      link(task.projectId, task.id, "project");
      link(task.repoId, task.id, "repo");
      link(task.id, task.deliverableId, "deliverable");
      for (const person of task.people) link(byName.get(person.toLowerCase()) ?? person, task.id, "person");
      for (const skillId of task.skillIds) link(task.id, skillId, "skill");
      for (const dependency of task.dependsOn) link(task.id, dependency, "depends");
    }
    for (const row of deliverables) link(row.projectId, row.id, "deliverable");
    for (const mention of mentions) link(mention.page.taskId, mention.entityId, "mention");
    for (const note of notes) {
      link(note.projectId, note.id, "note");
      link(note.repoId, note.id, "note");
      for (const personId of note.personIds) link(personId, note.id, "note");
    }
    for (const row of diagramLinks) link(row.diagramId, row.targetId, "diagram");
    for (const row of artifacts) {
      link(row.projectId, row.id, "artifact");
      link(row.repoId, row.id, "artifact");
      link(row.taskId, row.id, "artifact");
    }
    for (const session of sessions) {
      for (const personId of session.personIds) {
        link(personId, session.meetingNoteId, "attendee");
        link(personId, session.artifactId, "attendee");
      }
    }
    for (const document of documents) {
      if (!document.artifactId) continue;
      for (const id of document.projectIds) link(id, document.artifactId, "artifact");
      for (const id of document.personIds) link(id, document.artifactId, "artifact");
      for (const id of document.taskIds) link(id, document.artifactId, "artifact");
      for (const id of document.repoIds) link(id, document.artifactId, "artifact");
      for (const id of document.deliverableIds) link(id, document.artifactId, "artifact");
    }
    return { nodes, edges };
  });
}
