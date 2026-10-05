/**
 * Skill library (docs/05 §4). A skill is a SKILL.md body with frontmatter.
 * Every body change is a new version; retrieval only ever reads the current
 * one, and the last three are kept for rollback.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { appendLedger } from "../lib/ledger.js";
import { declareModule } from "../lib/module-gate.js";

const KEEP_VERSIONS = 3;

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60) || "skill";
}

/** Machine-checkable rules live in frontmatter as `rules:` bullet lines. */
function rulesFrom(body: string): Array<{ kind: string; value: string }> {
  const rules: Array<{ kind: string; value: string }> = [];
  for (const line of body.split("\n")) {
    const match = line.match(/^\s*-\s*(must-include|must-not-include|max-words|min-words):\s*(.+)$/i);
    if (match) rules.push({ kind: match[1]!.toLowerCase(), value: match[2]!.trim() });
  }
  return rules;
}

export async function skillRoutes(app: FastifyInstance): Promise<void> {
  declareModule(app, "skills");
  const { prisma } = app;

  app.get("/api/skills", async (request) => {
    const skills = await prisma.skill.findMany({
      where: { userId: request.userId, deletedAt: null },
      orderBy: [{ enabled: "desc" }, { name: "asc" }],
      include: { versions: { orderBy: { version: "desc" }, take: KEEP_VERSIONS } },
    });
    return { skills };
  });

  app.post("/api/skills", async (request, reply) => {
    const body = z.object({ name: z.string().min(1), description: z.string().default("") }).parse(request.body);
    const slug = slugify(body.name);
    const skillBody = [
      "---",
      `id: ${slug}.declared`,
      `name: ${body.name}`,
      "version: 1",
      "provenance: declared",
      "scope:",
      "  taskTypes: []",
      "rules:",
      "  - max-words: 250",
      "---",
      "",
      "## When to use",
      "",
      "## How I like it done",
      "",
    ].join("\n");
    const skill = await prisma.skill.create({
      data: {
        userId: request.userId,
        slug,
        name: body.name,
        description: body.description,
        body: skillBody,
        provenance: "declared",
        confidence: 0.5,
        versions: { create: { version: 1, body: skillBody, note: "created" } },
      },
    });
    return reply.code(201).send({ skill });
  });

  app.patch("/api/skills/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        enabled: z.boolean().optional(),
        body: z.string().optional(),
        note: z.string().optional(),
      })
      .parse(request.body);
    const skill = await prisma.skill.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!skill) return reply.code(404).send({ error: "Skill not found." });
    const bodyChanged = body.body !== undefined && body.body !== skill.body;
    const updated = await prisma.$transaction(async (tx) => {
      const next = await tx.skill.update({
        where: { id },
        data: {
          name: body.name,
          description: body.description,
          enabled: body.enabled,
          ...(bodyChanged ? { body: body.body, version: skill.version + 1 } : {}),
        },
      });
      if (bodyChanged) {
        await tx.skillVersion.create({
          data: { skillId: id, version: next.version, body: body.body!, note: body.note ?? "edited by you" },
        });
        const stale = await tx.skillVersion.findMany({
          where: { skillId: id },
          orderBy: { version: "desc" },
          skip: KEEP_VERSIONS,
          select: { id: true },
        });
        if (stale.length) await tx.skillVersion.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
      }
      return next;
    });
    if (bodyChanged) {
      await appendLedger({ userId: request.userId, actor: "me", action: "skill.edit", payload: { id, version: updated.version } });
    }
    return { skill: updated };
  });

  app.post("/api/skills/:id/restore", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { version } = z.object({ version: z.number().int() }).parse(request.body);
    const target = await prisma.skillVersion.findFirst({ where: { skillId: id, version, skill: { userId: request.userId } } });
    if (!target) return reply.code(404).send({ error: "Version not found." });
    const skill = await prisma.skill.findFirstOrThrow({ where: { id } });
    const next = await prisma.skill.update({ where: { id }, data: { body: target.body, version: skill.version + 1 } });
    await prisma.skillVersion.create({ data: { skillId: id, version: next.version, body: target.body, note: `restored v${version}` } });
    return { skill: next };
  });

  app.post("/api/skills/:id/score", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { draft } = z.object({ draft: z.string().min(1) }).parse(request.body);
    const skill = await prisma.skill.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!skill) return reply.code(404).send({ error: "Skill not found." });
    const words = draft.trim().split(/\s+/).filter(Boolean).length;
    const lower = draft.toLowerCase();
    const results = rulesFrom(skill.body).map((rule) => {
      switch (rule.kind) {
        case "must-include":
          return { rule: `${rule.kind}: ${rule.value}`, pass: lower.includes(rule.value.toLowerCase()) };
        case "must-not-include":
          return { rule: `${rule.kind}: ${rule.value}`, pass: !lower.includes(rule.value.toLowerCase()) };
        case "max-words":
          return { rule: `${rule.kind}: ${rule.value}`, pass: words <= Number(rule.value) };
        case "min-words":
          return { rule: `${rule.kind}: ${rule.value}`, pass: words >= Number(rule.value) };
        default:
          return { rule: rule.kind, pass: true };
      }
    });
    const passed = results.filter((row) => row.pass).length;
    return {
      words,
      results,
      score: results.length ? passed / results.length : null,
      note: results.length ? undefined : "This skill has no machine-checkable rules yet. Add `rules:` lines to its frontmatter.",
    };
  });

  app.delete("/api/skills/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.skill.updateMany({ where: { id, userId: request.userId }, data: { deletedAt: new Date() } });
    return reply.code(204).send();
  });
}
