/**
 * A scripted agent reads a task and its project, then draws only what that
 * context named. Another user cannot read it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import "../../config.js";
import { diagramContextTools } from "./diagram-context.js";
import { diagramTools } from "./diagrams.js";
import type { ToolContext } from "../types.js";
import { prisma } from "../../lib/prisma.js";

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function user(label: string) {
  return prisma.user.create({
    data: { email: `diagram-ctx-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@ensemble.test`, name: label },
  });
}

test("hub_diagram_context is enough to draw a task", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("owner");
  const other = await user("other");
  const tool = (name: string) => [...diagramContextTools, ...diagramTools].find((item) => item.name === name)!;
  const ctx = (userId: string): ToolContext => ({ prisma, userId, actor: "agent" }) as ToolContext;
  let projectId = "";
  try {
    const project = await prisma.project.create({
      data: { userId: owner.id, name: "Clinic visits", summary: "A clinic web app for visits." },
    });
    projectId = project.id;
    const deliverable = await prisma.deliverable.create({
      data: { userId: owner.id, projectId, title: "Visit records", notes: "The API stores visits in Postgres." },
    });
    const repo = await prisma.repo.create({
      data: { userId: owner.id, fullName: "clinic/app", description: "Clinic web app", provider: "github" },
    });
    await prisma.projectRepo.create({ data: { projectId, repoId: repo.id } });
    const task = await prisma.task.create({
      data: {
        userId: owner.id,
        title: "Draw the clinic flow",
        status: "todo",
        projectId,
        deliverableId: deliverable.id,
        description: "The clinic web app calls the API. The API stores visits in Postgres.",
      },
    });
    await prisma.taskPage.create({
      data: {
        userId: owner.id,
        taskId: task.id,
        content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Patients open the clinic web app." }] }] },
      },
    });
    await prisma.meetingNote.create({
      data: { userId: owner.id, projectId, title: "Clinic standup", answer: "Keep the visit store in Postgres." },
    });

    const result = await tool("hub_diagram_context").run(ctx(owner.id), { taskId: task.id });
    const data = result.data as {
      task: { title: string; description: string; pageText: string };
      project: { name: string; summary: string };
      deliverable: { title: string; notes: string };
      meetings: Array<{ title: string; excerpt: string }>;
      repos: Array<{ fullName: string }>;
    };
    const blob = JSON.stringify(data);
    for (const phrase of ["clinic web app", "API", "Postgres", "Clinic visits", "Visit records", "Clinic standup", "clinic/app"]) {
      assert.match(blob, new RegExp(phrase, "i"), phrase);
    }

    const lines = ["title Clinic visits", "direction right", "curve elbow", ""];
    if (/clinic web app/i.test(blob)) lines.push(`node app "Clinic web app" shape rounded`);
    if (/\bAPI\b/.test(blob)) lines.push(`node api "API" shape server`);
    if (/Postgres/i.test(blob)) lines.push(`node db "Postgres" shape cylinder`);
    lines.push("", "edge app > api", "edge api > db", "");
    const text = lines.join("\n");
    const validated = await tool("hub_validate_diagram").run(ctx(owner.id), { text });
    const report = validated.data as { ok: boolean; diagnostics: Array<{ message: string }> };
    assert.equal(report.ok, true, report.diagnostics?.map((item) => item.message).join("\n"));
    const created = await tool("hub_create_diagram").run(ctx(owner.id), {
      title: "Clinic visits",
      text,
      links: [{ kind: "task", id: task.id }],
    });
    const diagramId = (created.data as { id: string }).id;
    const saved = await tool("hub_get_diagram").run(ctx(owner.id), { diagramId });
    assert.match((saved.data as { source: string }).source, /Clinic web app/);
    assert.match((saved.data as { source: string }).source, /Postgres/);
    await assert.rejects(() => tool("hub_diagram_context").run(ctx(other.id), { taskId: task.id }));
    await assert.rejects(() => tool("hub_get_diagram").run(ctx(other.id), { diagramId }));
  } finally {
    await prisma.diagramLink.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.blockDiagram.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.meetingNote.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.task.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.project.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.repo.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
  }
});
