/**
 * One bounded read for the tiles that are not already on Today.
 * Takes are caps. Nothing here fans out per row.
 */
import type { FastifyInstance } from "fastify";

function linesFrom(content: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object" || out.length >= 10) return;
    const row = node as { type?: string; text?: string; content?: unknown[] };
    if (row.type === "text" && row.text?.trim()) out.push(row.text.trim());
    if (Array.isArray(row.content)) row.content.forEach(walk);
  };
  walk(content);
  return out.slice(0, 10);
}

export async function widgetRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  app.get("/api/widgets/feed", async (request) => {
    const userId = request.userId;
    const now = new Date();
    const soon = new Date(now.getTime() + 21 * 86_400_000);
    const [tasks, deliverables, reminders, people, artifacts, meetings, projects, events, pages, grouped] = await Promise.all([
      prisma.task.findMany({
        where: { userId, deletedAt: null },
        orderBy: { updatedAt: "desc" },
        take: 40,
        select: {
          id: true,
          title: true,
          taskType: true,
          due: true,
          status: true,
          measure: true,
          projectId: true,
          completedAt: true,
          updatedAt: true,
          people: true,
        },
      }),
      prisma.deliverable.findMany({
        where: { userId, deletedAt: null, status: "upcoming" },
        orderBy: [{ due: "asc" }, { createdAt: "asc" }],
        take: 12,
        select: { id: true, title: true, due: true, projectId: true, project: { select: { name: true } } },
      }),
      prisma.reminder.findMany({
        where: { userId, deletedAt: null, dismissedAt: null },
        orderBy: [{ dueDate: "asc" }],
        take: 12,
        select: { id: true, title: true, dueDate: true },
      }),
      prisma.person.findMany({
        where: { userId, deletedAt: null },
        orderBy: { name: "asc" },
        take: 12,
        select: { id: true, name: true },
      }),
      prisma.artifact.findMany({
        where: { userId, deletedAt: null, kind: "file" },
        orderBy: { ts: "desc" },
        take: 8,
        select: { id: true, title: true, projectId: true, ts: true },
      }),
      prisma.meetingNote.findMany({
        where: { userId, deletedAt: null },
        orderBy: { updatedAt: "desc" },
        take: 6,
        select: { id: true, title: true, personIds: true, updatedAt: true, projectId: true },
      }),
      prisma.project.findMany({
        where: { userId, deletedAt: null },
        orderBy: { updatedAt: "desc" },
        take: 8,
        select: { id: true, name: true },
      }),
      prisma.artifact.findMany({
        where: { userId, deletedAt: null, kind: "event", ts: { gte: now, lt: soon } },
        orderBy: { ts: "asc" },
        take: 8,
        select: { id: true, title: true, ts: true },
      }),
      prisma.taskPage.findMany({
        where: { userId, taskId: { not: null }, task: { deletedAt: null } },
        orderBy: { updatedAt: "desc" },
        take: 2,
        select: { taskId: true, content: true, task: { select: { title: true, projectId: true } } },
      }),
      prisma.task.groupBy({
        by: ["projectId", "status"],
        where: { userId, deletedAt: null, projectId: { not: null } },
        _count: true,
      }),
    ]);
    const progress = new Map<string, { done: number; total: number }>();
    for (const row of grouped) {
      if (!row.projectId) continue;
      const bucket = progress.get(row.projectId) ?? { done: 0, total: 0 };
      bucket.total += row._count;
      if (row.status === "done") bucket.done += row._count;
      progress.set(row.projectId, bucket);
    }
    return {
      tasks: tasks.map((task) => ({
        ...task,
        due: task.due?.toISOString() ?? null,
        completedAt: task.completedAt?.toISOString() ?? null,
        updatedAt: task.updatedAt.toISOString(),
      })),
      deliverables: deliverables.map((row) => ({
        id: row.id,
        title: row.title,
        due: row.due?.toISOString() ?? null,
        projectId: row.projectId,
        projectName: row.project.name,
      })),
      reminders,
      people,
      artifacts: artifacts.map((row) => ({ id: row.id, title: row.title || "Untitled", projectId: row.projectId, ts: row.ts.toISOString() })),
      meetings: meetings.map((row) => ({
        id: row.id,
        title: row.title,
        personIds: row.personIds,
        projectId: row.projectId,
        updatedAt: row.updatedAt.toISOString(),
      })),
      projects: projects.map((row) => ({ id: row.id, name: row.name, ...(progress.get(row.id) ?? { done: 0, total: 0 }) })),
      events: events.map((row) => ({ id: row.id, title: row.title || "Untitled", start: row.ts.toISOString() })),
      pages: pages.flatMap((row) =>
        row.task && row.taskId
          ? [{ taskId: row.taskId, title: row.task.title, projectId: row.task.projectId, lines: linesFrom(row.content) }]
          : [],
      ),
    };
  });
}
