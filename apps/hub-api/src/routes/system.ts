import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ASSISTANT_INSTRUCTIONS } from "../assistant/state.js";
import { TRIAGE_PROMPT } from "../connectors/triage.js";
import { connectionState, listConnectors } from "../connectors/base.js";
import { fetchAll, syncConnector } from "../connectors/sync.js";
import { complete, runtime } from "../lib/runtime.js";
import { hasModule, MODULE_DENIED } from "@ensemble/shared-types";
import { appendLedger } from "../lib/ledger.js";
import { loadSettings } from "../lib/settings.js";
import { sseHub } from "../lib/sse.js";
import { encrypt } from "../lib/secrets.js";
import { listActivities } from "../lib/activity.js";
import { GITHUB_GIT_PROVIDER } from "../lib/git-auth.js";
import { HostedAccessError, requireVerifiedUser } from "../lib/hosted-access.js";
import { mirrorSettings, spaceIds } from "../spaces/store.js";

const MODEL_CATALOG_TTL_MS = 15_000;
const MODEL_CATALOG_MAX = 32;
const modelCatalogCache = new Map<string, { at: number; body: unknown }>();

function readModelCatalog(userId: string): unknown | null {
  const hit = modelCatalogCache.get(userId);
  if (!hit) return null;
  if (Date.now() - hit.at > MODEL_CATALOG_TTL_MS) {
    modelCatalogCache.delete(userId);
    return null;
  }
  return hit.body;
}

function writeModelCatalog(userId: string, body: unknown): void {
  modelCatalogCache.delete(userId);
  modelCatalogCache.set(userId, { at: Date.now(), body });
  const now = Date.now();
  for (const [key, value] of modelCatalogCache) {
    if (now - value.at > MODEL_CATALOG_TTL_MS) modelCatalogCache.delete(key);
  }
  while (modelCatalogCache.size > MODEL_CATALOG_MAX) {
    const oldest = modelCatalogCache.keys().next().value;
    if (oldest === undefined) break;
    modelCatalogCache.delete(oldest);
  }
}

const PROMPTS = [
  {
    id: "assistant.system",
    title: "Hub assistant",
    when: "Every message you send in the Ensemble chat.",
    purpose: "Operate the Hub through typed tools. Never invent an entity, never promise work without calling a tool.",
    body: ASSISTANT_INSTRUCTIONS,
  },
  {
    id: "planner",
    title: "Planner",
    when: "When a delegated task starts or resumes after you answer a question.",
    purpose: "Turn a task and its context into steps with gates. Missing facts become questions, not guesses.",
  },
  {
    id: "drafter",
    title: "Drafter",
    when: "Replies, PR descriptions and documents, before any approval.",
    purpose: "Write in your tone using the matching skill. The draft is shown to you before anything leaves.",
  },
  {
    id: "classifier",
    title: "Triage",
    when: "After each fetch, once per new item.",
    purpose: "Decide whether an email, chat or PR needs a todo, and who should own it.",
    body: TRIAGE_PROMPT.split("<<ITEMS>>")[0]?.trim() ?? "",
  },
  {
    id: "coder",
    title: "Workspace coder",
    when: "Repository jobs in the Workspace.",
    purpose: "Edit files inside the checkout, run tests, and stop at the review gate before any commit or push.",
  },
  {
    id: "skill.miner",
    title: "Skill miner",
    when: "Only when you press “Improve skills from my work”.",
    purpose: "Propose skill updates from completed work with real examples. Proposals wait for your review.",
  },
];

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  app.get("/api/reminders", async (request) => {
    const reminders = await prisma.reminder.findMany({
      where: { userId: request.userId, deletedAt: null, dismissedAt: null },
      orderBy: [{ dueDate: "asc" }, { dueTime: "asc" }],
      select: { id: true, title: true, dueDate: true, dueTime: true, timeZone: true },
    });
    return { reminders };
  });

  app.get("/api/activity", async (request) => {
    return { activities: await listActivities(app.redis, request.userId) };
  });

  // ── connections & fetch ─────────────────────────────────────────────────

  app.get("/api/connections", async (request) => {
    const [settings, sync] = await Promise.all([
      loadSettings(prisma, request.userId),
      prisma.syncState.findMany({ where: { userId: request.userId } }),
    ]);
    const connections = await Promise.all(
      listConnectors().map(async (connector) => {
        const state = sync.find((row) => row.connector === connector.id);
        const status = await connectionState(request.userId, connector);
        const enabled = connector.connect === "builtin" || (settings.connections[connector.id]?.enabled ?? false);
        return {
          id: connector.id,
          label: connector.label,
          group: connector.group,
          description: connector.description,
          setupHint: connector.setupHint,
          provider: connector.account,
          connect: connector.connect,
          configured: status.configured,
          account: status.account,
          accountSource: status.source,
          appReady: status.appReady,
          scope: settings.connections[connector.id]?.scope ?? "",
          enabled,
          itemCount: state?.itemCount ?? 0,
          lastSyncAt: state?.lastSyncAt?.toISOString() ?? null,
          lastError: state?.lastError ?? null,
          needsAttention:
            enabled && connector.connect !== "builtin" && connector.connect !== "later" && (!status.configured || Boolean(state?.lastError)),
        };
      }),
    );
    return {
      connections,
      attention: connections.filter((row) => row.needsAttention).length,
      lastFetch: sync.reduce<string | null>((latest, row) => {
        const at = row.lastSyncAt?.toISOString() ?? null;
        return at && (!latest || at > latest) ? at : latest;
      }, null),
    };
  });

  app.post("/api/connections/:id/sync", async (request) => {
    const { id } = request.params as { id: string };
    const result = await syncConnector(app, request.userId, id);
    sseHub.publish(request.userId, { event: "sync", data: result });
    return result;
  });

  app.post("/api/fetch", async (request) => fetchAll(app, request.userId, "button"));

  // ── models & prompts ────────────────────────────────────────────────────

  app.get("/api/models", async (request) => {
    await requireVerifiedUser(request.userId);
    const cached = readModelCatalog(request.userId);
    if (cached) return cached;
    const settings = await loadSettings(prisma, request.userId);
    try {
      const catalog = await runtime<{ providers: Array<Record<string, unknown>> }>(
        `/api/models?${new URLSearchParams({ userId: request.userId, ollamaUrl: settings.models.ollamaUrl })}`,
        { timeoutMs: 30_000 },
      );
      const probes = await prisma.modelProbe.findMany({ where: { userId: request.userId } });
      const providers = catalog.providers.map((row) => {
        const provider = String(row.provider ?? "");
        const models = Array.isArray(row.models) ? row.models.map(String) : [];
        const notes: Record<string, { available: boolean; reason: string | null }> = {};
        for (const model of models) {
          const probe = probes.find((item) => item.provider === provider && item.model === model);
          if (!probe) continue;
          notes[model] = {
            available: probe.kind !== "not_found" && probe.kind !== "quota",
            reason: probe.detail || null,
          };
        }
        return { ...row, notes };
      });
      const payload = { providers, runtime: true, updatedAt: new Date().toISOString() };
      writeModelCatalog(request.userId, payload);
      return payload;
    } catch (error) {
      if (error instanceof HostedAccessError) throw error;
      const payload = {
        providers: [],
        runtime: false,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      };
      writeModelCatalog(request.userId, payload);
      return payload;
    }
  });

  /** With settings kept in sync, a key saved in one space is saved in all of them. */
  const mirrorKeys = async (userId: string, accountId: string) => {
    await mirrorSettings(prisma, userId);
    for (const id of await spaceIds(prisma, accountId)) modelCatalogCache.delete(id);
  };

  app.get("/api/model-keys", async (request) =>
    runtime<{ credentials: unknown[] }>(`/api/credentials?${new URLSearchParams({ userId: request.userId })}`),
  );

  app.put("/api/model-keys/:provider", async (request) => {
    const { provider } = request.params as { provider: string };
    const body = z.object({ apiKey: z.string().trim().min(8), baseUrl: z.string().url().optional() }).parse(request.body);
    modelCatalogCache.delete(request.userId);
    const result = await runtime<{ ok: boolean; models: number }>("/api/credentials", {
      method: "PUT",
      json: { userId: request.userId, provider, apiKey: body.apiKey, baseUrl: body.baseUrl },
    });
    // The ledger records that a key changed, never the key.
    await appendLedger({ userId: request.userId, actor: "me", action: "model.key.save", payload: { provider } });
    await mirrorKeys(request.userId, request.accountId);
    return result;
  });

  app.get("/api/secrets/github", async (request) => {
    const row = await prisma.modelCredential.findUnique({
      where: { userId_provider: { userId: request.userId, provider: GITHUB_GIT_PROVIDER } },
    });
    return { hint: row?.hint || null };
  });

  app.put("/api/secrets/github", async (request) => {
    const body = z.object({ token: z.string().trim().min(8) }).parse(request.body);
    const hint = `${body.token.slice(0, 4)}…${body.token.slice(-2)}`;
    await prisma.modelCredential.upsert({
      where: { userId_provider: { userId: request.userId, provider: GITHUB_GIT_PROVIDER } },
      create: { userId: request.userId, provider: GITHUB_GIT_PROVIDER, secret: encrypt(body.token), hint },
      update: { secret: encrypt(body.token), hint, updatedAt: new Date() },
    });
    await appendLedger({ userId: request.userId, actor: "me", action: "git.token.save", payload: { provider: GITHUB_GIT_PROVIDER } });
    return { hint };
  });

  app.delete("/api/secrets/github", async (request, reply) => {
    await prisma.modelCredential.deleteMany({ where: { userId: request.userId, provider: GITHUB_GIT_PROVIDER } });
    await appendLedger({ userId: request.userId, actor: "me", action: "git.token.remove", payload: {} });
    return reply.code(204).send();
  });

  app.delete("/api/model-keys/:provider", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    modelCatalogCache.delete(request.userId);
    await runtime(`/api/credentials/${provider}?${new URLSearchParams({ userId: request.userId })}`, { method: "DELETE" });
    await appendLedger({ userId: request.userId, actor: "me", action: "model.key.remove", payload: { provider } });
    await mirrorKeys(request.userId, request.accountId);
    return reply.code(204).send();
  });

  app.post("/api/models/test", async (request) => {
    const body = z.object({ tier: z.enum(["easy", "medium", "high", "max"]).default("easy") }).parse(request.body ?? {});
    const settings = await loadSettings(prisma, request.userId);
    const started = Date.now();
    const answer = await complete({
      userId: request.userId,
      settings,
      tier: body.tier,
      purpose: "Model test",
      prompt: "Reply with the single word: ready",
    });
    return { ok: true, model: answer.model, text: answer.text.trim().slice(0, 200), tokensIn: answer.tokensIn, tokensOut: answer.tokensOut, ms: Date.now() - started };
  });

  app.get("/api/prompts", async () => ({ prompts: PROMPTS }));

  // ── deleted items ───────────────────────────────────────────────────────

  app.get("/api/deleted", async (request) => {
    const where = { userId: request.userId, deletedAt: { not: null } };
    const [tasks, projects, people, skills, documents, repos, deliverables, reminders, comments, meetings, diagrams] = await Promise.all([
      prisma.task.findMany({ where, select: { id: true, title: true, deletedAt: true } }),
      prisma.project.findMany({ where, select: { id: true, name: true, deletedAt: true } }),
      prisma.person.findMany({ where, select: { id: true, name: true, deletedAt: true } }),
      hasModule(request.modules, "skills")
        ? prisma.skill.findMany({ where, select: { id: true, name: true, deletedAt: true } })
        : Promise.resolve([]),
      prisma.document.findMany({ where, select: { id: true, filename: true, deletedAt: true } }),
      prisma.repo.findMany({ where, select: { id: true, fullName: true, deletedAt: true } }),
      prisma.deliverable.findMany({ where, select: { id: true, title: true, deletedAt: true } }),
      prisma.reminder.findMany({ where, select: { id: true, title: true, deletedAt: true } }),
      prisma.pageDiscussion.findMany({ where, select: { id: true, quote: true, deletedAt: true } }),
      prisma.meetingSession.findMany({ where, select: { id: true, title: true, deletedAt: true } }),
      hasModule(request.modules, "diagrams")
        ? prisma.blockDiagram.findMany({ where, select: { id: true, title: true, deletedAt: true } })
        : Promise.resolve([]),
    ]);
    return {
      items: [
        ...tasks.map((row) => ({ kind: "task", id: row.id, label: row.title, deletedAt: row.deletedAt })),
        ...projects.map((row) => ({ kind: "project", id: row.id, label: row.name, deletedAt: row.deletedAt })),
        ...people.map((row) => ({ kind: "person", id: row.id, label: row.name, deletedAt: row.deletedAt })),
        ...skills.map((row) => ({ kind: "skill", id: row.id, label: row.name, deletedAt: row.deletedAt })),
        ...documents.map((row) => ({ kind: "document", id: row.id, label: row.filename, deletedAt: row.deletedAt })),
        ...repos.map((row) => ({ kind: "repo", id: row.id, label: row.fullName, deletedAt: row.deletedAt })),
        ...deliverables.map((row) => ({ kind: "deliverable", id: row.id, label: row.title, deletedAt: row.deletedAt })),
        ...reminders.map((row) => ({ kind: "reminder", id: row.id, label: row.title, deletedAt: row.deletedAt })),
        ...comments.map((row) => ({ kind: "comment", id: row.id, label: row.quote || "Comment", deletedAt: row.deletedAt })),
        ...meetings.map((row) => ({ kind: "meeting", id: row.id, label: row.title, deletedAt: row.deletedAt })),
        ...diagrams.map((row) => ({ kind: "diagram", id: row.id, label: row.title, deletedAt: row.deletedAt })),
      ],
    };
  });

  const DELEGATES = {
    task: prisma.task,
    project: prisma.project,
    person: prisma.person,
    skill: prisma.skill,
    document: prisma.document,
    repo: prisma.repo,
    deliverable: prisma.deliverable,
    reminder: prisma.reminder,
    comment: prisma.pageDiscussion,
    meeting: prisma.meetingSession,
    diagram: prisma.blockDiagram,
  } as const;

  app.post("/api/deleted/restore", async (request, reply) => {
    const body = z
      .object({
        kind: z.enum(["task", "project", "person", "skill", "document", "repo", "deliverable", "reminder", "comment", "meeting", "diagram"]).optional(),
        id: z.string().optional(),
      })
      .parse(request.body ?? {});
    const where = { userId: request.userId, deletedAt: { not: null }, ...(body.id ? { id: body.id } : {}) };
    if (body.kind === "skill" && !hasModule(request.modules, "skills")) {
      return reply.code(404).send({ error: MODULE_DENIED });
    }
    if (body.kind === "diagram" && !hasModule(request.modules, "diagrams")) {
      return reply.code(404).send({ error: MODULE_DENIED });
    }
    const kinds = (body.kind ? [body.kind] : (Object.keys(DELEGATES) as Array<keyof typeof DELEGATES>)).filter(
      (kind) => (kind !== "skill" || hasModule(request.modules, "skills")) && (kind !== "diagram" || hasModule(request.modules, "diagrams")),
    );
    let restored = 0;
    for (const kind of kinds) {
      const delegate = DELEGATES[kind] as unknown as {
        updateMany: (args: unknown) => Promise<{ count: number }>;
      };
      restored += (await delegate.updateMany({ where, data: { deletedAt: null } })).count;
    }
    sseHub.publish(request.userId, { event: "task", data: { action: "restore" } });
    return { restored };
  });

  app.post("/api/deleted/empty", async (request) => {
    const where = { userId: request.userId, deletedAt: { not: null } };
    let removed = 0;
    for (const delegate of Object.values(DELEGATES)) {
      removed += (await (delegate as unknown as { deleteMany: (args: unknown) => Promise<{ count: number }> }).deleteMany({ where })).count;
    }
    await appendLedger({ userId: request.userId, actor: "me", action: "deleted.empty", payload: { removed } });
    return { removed };
  });

  // ── delete my data ──────────────────────────────────────────────────────

  app.post("/api/data/delete", async (request, reply) => {
    const body = z
      .object({ scope: z.enum(["context", "everything"]), confirm: z.string() })
      .parse(request.body);
    const settings = await loadSettings(prisma, request.userId);
    if (body.confirm.trim().toLowerCase() !== settings.email.toLowerCase()) {
      return reply.code(400).send({ error: `Type ${settings.email} to confirm.` });
    }
    const userId = request.userId;
    await prisma.$transaction(async (tx) => {
      await tx.artifact.deleteMany({ where: { userId } });
      await tx.document.deleteMany({ where: { userId } });
      await tx.meetingNote.deleteMany({ where: { userId } });
      await tx.meetingSession.deleteMany({ where: { userId } });
      await tx.extraction.deleteMany({ where: { userId } });
      await tx.contextPack.deleteMany({ where: { userId } });
      await tx.syncState.deleteMany({ where: { userId } });
      await tx.person.deleteMany({ where: { userId } });
      await tx.repo.deleteMany({ where: { userId } });
      if (body.scope === "everything") {
        // Linked pages cascade from the task. Standalone notes have no task,
        // so they would survive a task delete and stay in context search.
        // Mentions cascade from the page. search_text is a column on this row.
        await tx.taskPage.deleteMany({ where: { userId } });
        await tx.task.deleteMany({ where: { userId } });
        await tx.project.deleteMany({ where: { userId } });
        await tx.skill.deleteMany({ where: { userId } });
        await tx.assistantConversation.deleteMany({ where: { userId } });
        await tx.reminder.deleteMany({ where: { userId } });
        await tx.notification.deleteMany({ where: { userId } });
        await tx.undoEntry.deleteMany({ where: { userId } });
      }
    });
    // The ledger records that a deletion happened, and nothing about what was deleted.
    await appendLedger({ userId, actor: "me", action: `data.delete.${body.scope}` });
    return { ok: true };
  });
}
