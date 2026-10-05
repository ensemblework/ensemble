/**
 * Sample rows so the Hub is usable before mail and GitHub are connected.
 * Re-running replaces anything tagged sourceRef "seed:" and rebuilds the
 * five local checkouts under ENSEMBLE_WORKSPACE_ROOT/samples.
 *
 *   pnpm db:seed
 */
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SETTINGS, Settings } from "@ensemble/shared-types";
import { ensureLocalDatabase } from "../scripts/ensure-local-db.mjs";
import { env } from "../src/config.js";
import { git, parseDiff } from "../src/lib/git.js";
import { prisma } from "../src/lib/prisma.js";
import { deepMerge } from "../src/lib/settings.js";
import { expandHome } from "../src/workspace/guard.js";

const USER = env.ENSEMBLE_DEV_USER_ID;

const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000);
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

async function main(): Promise<void> {
  const database = await ensureLocalDatabase();
  if (database.action === "failed") {
    process.exitCode = database.status ?? 1;
    return;
  }
  await prisma.task.deleteMany({ where: { userId: USER, sourceRef: { startsWith: "seed:" } } });
  await prisma.meetingNote.deleteMany({ where: { userId: USER, source: "seed" } });
  await prisma.artifact.deleteMany({ where: { userId: USER, externalId: { startsWith: "seed:" } } });
  await prisma.document.deleteMany({ where: { userId: USER, filename: { startsWith: "seed-" } } });
  await prisma.agentDecision.deleteMany({ where: { userId: USER, title: { startsWith: "Seed:" } } });
  await prisma.notification.deleteMany({ where: { userId: USER, title: { startsWith: "Sample:" } } });
  await prisma.reminder.deleteMany({ where: { userId: USER, title: { startsWith: "Sample:" } } });
  await prisma.assistantConversation.deleteMany({ where: { userId: USER, title: { startsWith: "Sample ·" } } });

  const priya = await upsertPerson({
    upn: "priya.nair@example.com",
    name: "Priya Nair",
    email: "priya.nair@example.com",
    role: "Engineering manager",
    team: "Platform",
    relationshipWeight: 0.9,
    typicalResponseHours: 4,
  });
  const rahul = await upsertPerson({
    upn: "rahul.mehta@example.com",
    name: "Rahul Mehta",
    email: "rahul.mehta@example.com",
    role: "Backend engineer",
    team: "Platform",
    relationshipWeight: 0.7,
    typicalResponseHours: 8,
  });
  const shachee = await upsertPerson({
    upn: "shachee.kapoor@example.com",
    name: "Shachee Kapoor",
    email: "shachee.kapoor@example.com",
    role: "Design",
    team: "Product",
    relationshipWeight: 0.6,
    typicalResponseHours: 12,
  });
  const alex = await upsertPerson({
    upn: "alex.chen@example.com",
    name: "Alex Chen",
    email: "alex.chen@example.com",
    role: "Maintainer",
    team: "Open source",
    relationshipWeight: 0.4,
  });

  const fastapi = await upsertRepo({
    fullName: "fastapi/fastapi",
    url: "https://github.com/fastapi/fastapi",
    description: "Modern Python web framework. Tracked as a reference repo, not a clone.",
    languages: ["Python"],
    myRole: "contributor",
  });
  const httpx = await upsertRepo({
    fullName: "encode/httpx",
    url: "https://github.com/encode/httpx",
    description: "A next-generation HTTP client for Python.",
    languages: ["Python"],
    myRole: "contributor",
  });
  const ruff = await upsertRepo({
    fullName: "astral-sh/ruff",
    url: "https://github.com/astral-sh/ruff",
    description: "An extremely fast Python linter and formatter.",
    languages: ["Rust", "Python"],
    myRole: "contributor",
  });
  const prismaRepo = await upsertRepo({
    fullName: "prisma/prisma",
    url: "https://github.com/prisma/prisma",
    description: "Next-generation ORM for Node.js and TypeScript.",
    languages: ["TypeScript"],
    myRole: "contributor",
  });

  const hub = await upsertProject({
    name: "Ensemble Hub",
    summary: "The localhost coworker: board, context, and the assistant.",
    people: [
      [priya.id, "manager"],
      [rahul.id, "engineer"],
      [shachee.id, "design"],
    ],
    repos: [fastapi.id, httpx.id],
  });
  const oss = await upsertProject({
    name: "Open source maintenance",
    summary: "Small reviews on public repos you follow.",
    people: [[alex.id, "maintainer"]],
    repos: [ruff.id, prismaRepo.id],
  });

  const latency = await upsertDeliverable(hub.id, "Latency numbers for Priya", daysFromNow(0));
  await upsertDeliverable(hub.id, "Ranker ADR", daysFromNow(3));
  await upsertDeliverable(oss.id, "httpx timeout note", daysFromNow(2));

  const emailSkill = await upsertSkill({
    slug: "email-tone",
    name: "Email tone",
    description: "Short replies, lead with the number, no filler greeting.",
    body: "Write like a colleague who already has the thread open.\nLead with the answer or the number.\nOne short paragraph, then a link or a next step.\nDo not open with \"I hope this email finds you well.\"",
    provenance: "declared",
    acceptanceRate: 0.8,
    acceptedCount: 8,
    editedCount: 2,
  });
  const prSkill = await upsertSkill({
    slug: "pr-description",
    name: "PR description",
    description: "What changed, why, and how to test. No changelog dump.",
    body: "Title is imperative and specific.\nBody has three parts: what changed, why, how to test.\nMention the risk if a public API moved.\nDo not paste the whole diff into the description.",
    provenance: "mined",
    acceptanceRate: 0.7,
    acceptedCount: 5,
    editedCount: 2,
    minedFrom: 14,
  });
  await upsertSkill({
    slug: "commit-style",
    name: "Commit messages",
    description: "One line, present tense, the why if it is not obvious.",
    body: "Subject under 72 characters, present tense.\nNo trailing period.\nBody only when the why is not in the subject.",
    provenance: "bootstrap",
  });
  await upsertSkill({
    slug: "adr-writing",
    name: "ADR writing",
    description: "Context, decision, consequences. One page.",
    body: "Start with the problem in two sentences.\nList the options you actually considered.\nState the decision, then the consequences and what you are not doing.",
    provenance: "provisional",
    proposedBody: "Keep the one-page limit.\nAdd a \"revisit when\" line so a future reader knows the decision is not permanent.",
  });

  const reply = await task({
    title: "Reply to Priya with the latency numbers",
    description: "She asked for p95 before and after the ranker change, by end of day.",
    sourceKind: "email",
    sourceRef: "seed:priya-latency",
    excerpt: "Can you send the p95 before and after by EOD? Leadership is asking.",
    owner: "agent",
    status: "waiting_approval",
    priority: "p0",
    complexity: "easy",
    due: daysFromNow(0),
    projectId: hub.id,
    deliverableId: latency.id,
    people: [priya.id],
    skillIds: [emailSkill.id],
    rationale: "The thread already names the metric and the deadline.",
    todayFocus: "keep",
  });
  const adr = await task({
    title: "Write the ranker ADR",
    description: "Decision from yesterday's design review. You own the write-up; Rahul owns the load test.",
    sourceKind: "meeting",
    sourceRef: "seed:ranker-adr",
    owner: "me",
    status: "todo",
    priority: "p1",
    complexity: "high",
    due: daysFromNow(2),
    projectId: hub.id,
    people: [rahul.id, shachee.id],
    todayFocus: "keep",
  });
  await task({
    title: "Bump the retry helper and open a PR",
    description: "Small dependency bump. The PR description should follow the PR skill.",
    sourceKind: "github",
    sourceRef: "seed:retry-bump",
    owner: "agent",
    status: "in_progress",
    priority: "p1",
    complexity: "medium",
    due: daysFromNow(1),
    projectId: oss.id,
    repoId: httpx.id,
    skillIds: [prSkill.id],
    todayFocus: "keep",
  });
  await task({
    title: "Triage the stale review on the timeout comment",
    description: "A review comment has been open for three days.",
    sourceKind: "github",
    sourceRef: "seed:stale-review",
    owner: "me",
    status: "todo",
    priority: "p1",
    complexity: "easy",
    projectId: oss.id,
    repoId: httpx.id,
  });
  await task({
    title: "Proposed: follow up with Shachee on the empty-state copy",
    description: "She left a note on the Today empty state. Not assigned yet.",
    sourceKind: "teams",
    sourceRef: "seed:empty-copy",
    excerpt: "The empty board still says 'No tasks'. Can we say what to do next?",
    owner: "unassigned",
    status: "proposed",
    priority: "p2",
    complexity: "easy",
    projectId: hub.id,
    people: [shachee.id],
    rationale: "A wording change, not a product decision.",
  });
  await task({
    title: "Proposed: look at the Ruff preview changelog",
    description: "Alex mentioned a formatter change that might touch commit style.",
    sourceKind: "github",
    sourceRef: "seed:ruff-preview",
    owner: "unassigned",
    status: "proposed",
    priority: "p2",
    complexity: "easy",
    projectId: oss.id,
    repoId: ruff.id,
    people: [alex.id],
  });
  const blocked = await task({
    title: "Load-test plan is waiting on the traffic mix",
    description: "Rahul asked which mix to use. The agent stopped instead of guessing.",
    sourceKind: "manual",
    sourceRef: "seed:load-test",
    owner: "agent",
    status: "blocked",
    priority: "p1",
    complexity: "medium",
    projectId: hub.id,
    people: [rahul.id],
    blockedQuestion: {
      prompt: "Which traffic mix should the load test use?",
      options: ["Last week's production mix", "Even split across the three rankers", "I'll write it myself"],
    },
  });
  await task({
    title: "Sketch the morning briefing layout",
    description: "Already done. Left here so the Done column is not empty.",
    sourceKind: "manual",
    sourceRef: "seed:briefing-layout",
    owner: "me",
    status: "done",
    priority: "p2",
    complexity: "medium",
    projectId: hub.id,
    people: [shachee.id],
    completedAt: daysFromNow(-1),
  });
  await task({
    title: "Read the Prisma relation-mode notes",
    description: "Background reading. Done.",
    sourceKind: "manual",
    sourceRef: "seed:prisma-notes",
    owner: "me",
    status: "done",
    priority: "p2",
    complexity: "easy",
    projectId: oss.id,
    repoId: prismaRepo.id,
    completedAt: daysFromNow(-2),
  });

  await prisma.planStep.createMany({
    data: [
      { taskId: reply.id, index: 0, title: "Pull the p95 from the last context pack", status: "done" },
      { taskId: reply.id, index: 1, title: "Draft the reply in your email tone", status: "needs_approval" },
      { taskId: adr.id, index: 0, title: "Outline context, decision, consequences", status: "pending" },
    ],
  });

  const replyRun = await prisma.run.create({
    data: {
      taskId: reply.id,
      userId: USER,
      worker: "drafter",
      skillIds: [emailSkill.id],
      cursor: 1,
      outcome: "waiting_approval",
      requestedModel: "gemini-3.5-flash-lite",
      plannerModel: "gemini-3.5-flash-lite",
      result: "Draft is ready. Nothing has been sent.",
    },
  });
  await prisma.runStep.create({
    data: {
      runId: replyRun.id,
      index: 0,
      title: "Draft the reply",
      status: "needs_approval",
      model: "gemini-3.5-flash-lite",
      output: "Drafted. Waiting for approval before anything is sent.",
      startedAt: daysFromNow(0),
    },
  });
  await prisma.approval.create({
    data: {
      runId: replyRun.id,
      taskId: reply.id,
      userId: USER,
      kind: "send_email",
      title: "Reply to Priya Nair",
      stepIndex: 1,
      preview: {
        to: "priya.nair@example.com",
        subject: "Re: ranker latency",
        body: "p95 went from 240ms to 180ms after the ranker change (yesterday, production, n=1.2M).\nI'll send the dashboard link in the thread.\n\nAkash",
      },
    },
  });

  const prRun = await prisma.run.create({
    data: {
      taskId: blocked.id,
      userId: USER,
      worker: "planner",
      cursor: 0,
      outcome: "needs_info",
      requestedModel: "gemini-3.5-flash-lite",
      question: { prompt: "Which traffic mix should the load test use?" },
    },
  });
  await prisma.approval.create({
    data: {
      runId: prRun.id,
      taskId: blocked.id,
      userId: USER,
      kind: "open_pr",
      title: "Open the retry-helper pull request",
      stepIndex: 0,
      preview: {
        repo: "encode/httpx",
        title: "Clarify the default timeout in the README",
        body: "The README still says the client waits forever. The default is 5 seconds.\n\nHow to test: open the README diff.",
      },
    },
  });

  await prisma.taskTransition.createMany({
    data: [
      { userId: USER, taskId: reply.id, toStatus: "proposed", toOwner: "unassigned", actor: "agent", reason: "fetch" },
      { userId: USER, taskId: reply.id, fromStatus: "proposed", toStatus: "waiting_approval", fromOwner: "unassigned", toOwner: "agent", actor: "me", reason: "assign" },
    ],
  });

  await prisma.meetingNote.create({
    data: {
      userId: USER,
      title: "Ranker design review",
      source: "seed",
      prompt: "What did I agree to?",
      answer: "You write the ADR. Rahul owns the load test. Priya wants latency numbers today.",
      occurredAt: daysFromNow(-1),
      personIds: [priya.id, rahul.id, shachee.id],
      projectId: hub.id,
      status: "ready",
    },
  });

  await prisma.notification.createMany({
    data: [
      { userId: USER, kind: "approval", title: "Sample: reply to Priya is waiting", body: "Needs me · nothing has been sent.", taskId: reply.id },
      { userId: USER, kind: "task", title: "Sample: two proposed todos from this morning", body: "Triage them on Today." },
    ],
  });

  const tomorrow = isoDay(daysFromNow(1));
  await prisma.reminder.createMany({
    data: [
      {
        userId: USER,
        title: "Sample: send Priya the dashboard link",
        titleContent: { type: "text", text: "Sample: send Priya the dashboard link" },
        dueDate: isoDay(new Date()),
        dueTime: "17:30",
        timeZone: env.ENSEMBLE_TIMEZONE,
        actionTokenHash: createHash("sha256").update(`seed-reminder-1-${USER}`).digest("hex"),
      },
      {
        userId: USER,
        title: "Sample: review the ADR outline",
        titleContent: { type: "text", text: "Sample: review the ADR outline" },
        dueDate: tomorrow,
        timeZone: env.ENSEMBLE_TIMEZONE,
        actionTokenHash: createHash("sha256").update(`seed-reminder-2-${USER}`).digest("hex"),
      },
    ],
  });

  const conversation = await prisma.assistantConversation.create({
    data: { userId: USER, title: "Sample · latency numbers" },
  });
  await prisma.assistantMessage.createMany({
    data: [
      { conversationId: conversation.id, userId: USER, role: "user", content: "What did Priya ask for?" },
      {
        conversationId: conversation.id,
        userId: USER,
        role: "assistant",
        content: "This is sample history, not a live model call. Priya asked for p95 before and after, by end of day. The draft is on Needs me.",
        model: "sample",
      },
    ],
  });

  const current = await prisma.preference.findFirst({ where: { userId: USER, key: "hub.settings" } });
  const base = Settings.safeParse(current?.value ?? {}).success ? Settings.parse(current?.value ?? {}) : DEFAULT_SETTINGS;
  const next = Settings.parse(
    deepMerge(base as unknown as Record<string, unknown>, {
      models: {
        easy: { provider: "google", model: "gemini-3.5-flash-lite", effort: "default" },
        medium: { provider: "google", model: "gemini-3.5-flash-lite", effort: "default" },
        high: { provider: "google", model: "gemini-3.5-flash-lite", effort: "default" },
        max: { provider: "google", model: "gemini-3.5-flash-lite", effort: "default" },
      },
    }),
  );
  await prisma.preference.upsert({
    where: { userId_key: { userId: USER, key: "hub.settings" } },
    create: { userId: USER, key: "hub.settings", value: next, source: "me" },
    update: { value: next, deletedAt: null },
  });

  await seedBridgeFixtures({ hubId: hub.id, ossId: oss.id, httpxId: httpx.id, alexId: alex.id, replyId: reply.id });

  const reviews = await seedReviews();
  console.log(`Seeded user ${USER}: tasks, people, projects, skills, bridge fixtures, and ${reviews} code reviews.`);
}

async function upsertPerson(data: {
  upn: string;
  name: string;
  email: string;
  role: string;
  team: string;
  relationshipWeight: number;
  typicalResponseHours?: number;
}) {
  return prisma.person.upsert({
    where: { userId_upn: { userId: USER, upn: data.upn } },
    create: { userId: USER, ...data, lastInteraction: daysFromNow(-1), evidence: ["seed"], confidence: 0.8 },
    update: { ...data, deletedAt: null },
  });
}

async function upsertRepo(data: {
  fullName: string;
  url: string;
  description: string;
  languages: string[];
  myRole: "owner" | "maintainer" | "contributor";
}) {
  return prisma.repo.upsert({
    where: { userId_fullName: { userId: USER, fullName: data.fullName } },
    create: {
      userId: USER,
      ...data,
      provider: "github",
      defaultBranch: "main",
      tracked: true,
      evidence: ["seed"],
      confidence: 0.9,
      prStats: { open: 1, reviewRequested: 1 },
    },
    update: { ...data, tracked: true, deletedAt: null },
  });
}

async function upsertProject(data: { name: string; summary: string; people: Array<[string, string]>; repos: string[] }) {
  const project = await prisma.project.upsert({
    where: { userId_name: { userId: USER, name: data.name } },
    create: { userId: USER, name: data.name, summary: data.summary, createdBy: "me", evidence: ["seed"], confidence: 0.9 },
    update: { summary: data.summary, deletedAt: null, status: "active" },
  });
  for (const [personId, role] of data.people) {
    await prisma.projectPerson.upsert({
      where: { projectId_personId: { projectId: project.id, personId } },
      create: { projectId: project.id, personId, role, addedBy: "me" },
      update: { role },
    });
  }
  for (const repoId of data.repos) {
    await prisma.projectRepo.upsert({
      where: { projectId_repoId: { projectId: project.id, repoId } },
      create: { projectId: project.id, repoId, addedBy: "me" },
      update: {},
    });
  }
  return project;
}

async function upsertDeliverable(projectId: string, title: string, due: Date) {
  const existing = await prisma.deliverable.findFirst({ where: { userId: USER, projectId, title } });
  if (existing) {
    return prisma.deliverable.update({ where: { id: existing.id }, data: { due, deletedAt: null, status: "upcoming" } });
  }
  return prisma.deliverable.create({
    data: { userId: USER, projectId, title, due, owner: "me", createdBy: "me" },
  });
}

async function upsertSkill(data: {
  slug: string;
  name: string;
  description: string;
  body: string;
  provenance: "bootstrap" | "provisional" | "mined" | "declared";
  acceptanceRate?: number;
  acceptedCount?: number;
  editedCount?: number;
  minedFrom?: number;
  proposedBody?: string;
}) {
  return prisma.skill.upsert({
    where: { userId_slug: { userId: USER, slug: data.slug } },
    create: { userId: USER, ...data, evidence: ["seed"], confidence: 0.75, enabled: true },
    update: { ...data, deletedAt: null, enabled: true },
  });
}

async function task(data: {
  title: string;
  description: string;
  sourceKind: "email" | "teams" | "meeting" | "github" | "manual" | "notion" | "linear" | "other";
  sourceRef: string;
  excerpt?: string;
  owner: "me" | "agent" | "unassigned";
  status: "proposed" | "todo" | "in_progress" | "waiting_approval" | "blocked" | "done" | "dropped";
  priority: "p0" | "p1" | "p2";
  complexity: "easy" | "medium" | "high" | "max";
  due?: Date;
  projectId?: string;
  repoId?: string;
  deliverableId?: string;
  people?: string[];
  skillIds?: string[];
  rationale?: string;
  todayFocus?: string;
  blockedQuestion?: unknown;
  completedAt?: Date;
}) {
  return prisma.task.create({
    data: {
      userId: USER,
      createdBy: data.sourceKind === "manual" ? "me" : "agent",
      boardOrder: Date.now() + Math.random(),
      confidence: 0.8,
      agentSuitability: data.owner === "agent" ? 0.85 : 0.4,
      ...data,
      blockedQuestion: data.blockedQuestion as never,
    },
  });
}

/**
 * Rows the Context Bridge reads that the sample board does not create:
 * a branch-linked task, an ambiguous branch, calendar events, a file,
 * a document, an email artifact, and a pending editor decision.
 * Re-running is safe: main() deletes the seed: / seed- / Seed: tags first.
 */
async function seedBridgeFixtures(ids: {
  hubId: string;
  ossId: string;
  httpxId: string;
  alexId: string;
  replyId: string;
}): Promise<void> {
  const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000);

  await task({
    title: "Dropped: rewrite the fetch loop",
    description: "Superseded by the ranker change. Kept so the dropped column is represented.",
    sourceKind: "manual",
    sourceRef: "seed:dropped-fetch",
    owner: "me",
    status: "dropped",
    priority: "p2",
    complexity: "medium",
    projectId: ids.hubId,
  });

  const timeout = await task({
    title: "Clarify the default timeout in the README",
    description: "The README still says the client waits forever. The default is 5 seconds.",
    sourceKind: "github",
    sourceRef: "seed:timeout-readme",
    excerpt: "Default timeout is 5 seconds, not forever.",
    owner: "me",
    status: "in_progress",
    priority: "p1",
    complexity: "easy",
    due: daysFromNow(4),
    projectId: ids.ossId,
    repoId: ids.httpxId,
    people: [ids.alexId],
    todayFocus: "keep",
  });
  await prisma.workspaceSession.create({
    data: {
      userId: USER,
      taskId: timeout.id,
      repoFullName: "encode/httpx",
      branch: "docs/default-timeout",
      status: "open",
      handoffNote: "Seeded so the Context Bridge can resolve this branch to one open task.",
    },
  });
  await prisma.workspaceJob.create({
    data: {
      userId: USER,
      taskId: timeout.id,
      kind: "code",
      status: "succeeded",
      executionMode: "native",
      model: "sample",
      branch: "docs/default-timeout",
      baseBranch: "main",
      repoUrl: "https://github.com/encode/httpx",
      instructions: "Sample job so branch resolution sees a workspace job. Not a live agent run.",
      finishedAt: daysFromNow(-1),
    },
  });

  const ambiguous = [
    await task({
      title: "Split the retry budget",
      description: "Two open tasks share the retry-helper branch on purpose.",
      sourceKind: "github",
      sourceRef: "seed:amb-retry-budget",
      owner: "me",
      status: "todo",
      priority: "p1",
      complexity: "medium",
      projectId: ids.ossId,
      repoId: ids.httpxId,
    }),
    await task({
      title: "Log retry reasons",
      description: "The other open task on retry-helper. The bridge must not pick one.",
      sourceKind: "github",
      sourceRef: "seed:amb-retry-log",
      owner: "agent",
      status: "in_progress",
      priority: "p2",
      complexity: "easy",
      projectId: ids.ossId,
      repoId: ids.httpxId,
    }),
  ];
  for (const row of ambiguous) {
    await prisma.workspaceSession.create({
      data: {
        userId: USER,
        taskId: row.id,
        repoFullName: "encode/httpx",
        branch: "retry-helper",
        status: "open",
      },
    });
  }

  await prisma.meetingNote.create({
    data: {
      userId: USER,
      title: "httpx timeout discussion",
      source: "seed",
      prompt: "What did we decide about the default timeout?",
      answer: "The README should say the default timeout is 5 seconds, not forever.",
      occurredAt: daysFromNow(-2),
      personIds: [ids.alexId],
      projectId: ids.ossId,
      repoId: ids.httpxId,
      status: "ready",
    },
  });

  const events: Array<{ externalId: string; title: string; hours: number; location: string }> = [
    { externalId: "seed:event-latency", title: "Latency readout with Priya", hours: 4, location: "Meet room 2" },
    { externalId: "seed:event-adr", title: "ADR writing block", hours: 72, location: "Focus time" },
    { externalId: "seed:event-httpx", title: "httpx maintainer office hours", hours: 240, location: "https://meet.example.com/httpx" },
  ];
  for (const event of events) {
    const start = hoursFromNow(event.hours);
    await prisma.artifact.create({
      data: {
        userId: USER,
        kind: "event",
        externalId: event.externalId,
        ts: start,
        title: event.title,
        text: `${event.title} — sample calendar invite, not a real meeting.`,
        projectId: event.externalId === "seed:event-httpx" ? ids.ossId : ids.hubId,
        authoredByMe: false,
        participants: [{ name: "Priya Nair", email: "priya.nair@example.com" }],
        metadata: {
          end: new Date(start.getTime() + 3_600_000).toISOString(),
          location: event.location,
          source: "seed",
        },
      },
    });
  }

  await prisma.artifact.create({
    data: {
      userId: USER,
      kind: "email",
      externalId: "seed:priya-email",
      ts: daysFromNow(-1),
      title: "Re: ranker latency",
      text: "Can you send the p95 before and after by EOD? Leadership is asking. — Priya",
      projectId: ids.hubId,
      taskId: ids.replyId,
      authoredByMe: false,
      url: "https://mail.example.com/priya-latency",
      participants: [{ name: "Priya Nair", email: "priya.nair@example.com" }],
    },
  });

  const note = "p95 went from 240ms to 180ms after the ranker change. This file is the readout Priya asked for.";
  const bytes = Buffer.from(note, "utf8");
  await prisma.document.create({
    data: {
      userId: USER,
      filename: "seed-ranker-notes.md",
      mediaType: "text/markdown",
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      original: bytes,
      format: "md",
      parseStatus: "ready",
      parserVersion: "seed",
      textCharacters: note.length,
      parsedAt: new Date(),
      enrichmentStatus: "skipped",
      summary: "Latency readout: p95 240ms to 180ms.",
      projectIds: [ids.hubId],
      artifact: {
        create: {
          userId: USER,
          kind: "file",
          externalId: "seed:ranker-notes",
          ts: new Date(),
          title: "seed-ranker-notes.md",
          text: note,
          projectId: ids.hubId,
          authoredByMe: true,
        },
      },
    },
  });

  await prisma.agentDecision.create({
    data: {
      userId: USER,
      source: "cursor",
      event: "beforeShellExecution",
      toolName: "Shell",
      title: "Seed: Cursor wants to run npm test",
      detail: { command: "npm test", input: { command: "npm test" } },
      cwd: "/workspace",
      status: "pending",
      expiresAt: daysFromNow(1),
    },
  });
}

async function seedReviews(): Promise<number> {
  // The default root is `~/ensemble-workspace`. Expand it the same way the API
  // does, or sample repos land in a literal "~" folder and Code refuses them
  // because the stored path is not absolute.
  const root = join(expandHome(env.ENSEMBLE_WORKSPACE_ROOT), "samples");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  const specs: Array<{
    slug: string;
    title: string;
    branch: string;
    files: Record<string, string>;
    edits: Record<string, string>;
    complete: boolean;
    accept: boolean;
  }> = [
    {
      slug: "timeout-readme",
      title: "Clarify the default timeout",
      branch: "ensemble/timeout-readme",
      files: { "README.md": "# Client\n\nThe client waits forever.\n" },
      edits: { "README.md": "# Client\n\nThe default timeout is 5 seconds.\n" },
      complete: false,
      accept: false,
    },
    {
      slug: "retry-note",
      title: "Document retry backoff",
      branch: "ensemble/retry-note",
      files: { "NOTES.md": "Retries: immediate.\n" },
      edits: { "NOTES.md": "Retries: three attempts, exponential backoff, cap 8s.\n" },
      complete: false,
      accept: false,
    },
    {
      slug: "idempotency-key",
      title: "Add an idempotency key helper",
      branch: "ensemble/idempotency-key",
      files: { "src/client.ts": "export function call() {\n  return true;\n}\n" },
      edits: {
        "src/client.ts": "export function call() {\n  return true;\n}\n\nexport function idempotencyKey() {\n  return crypto.randomUUID();\n}\n",
      },
      complete: false,
      accept: false,
    },
    {
      slug: "log-line",
      title: "Tighten the timeout log line",
      branch: "ensemble/log-line",
      files: { "src/log.ts": "export const message = \"timed out maybe\";\n" },
      edits: { "src/log.ts": "export const message = \"timed out after 5s\";\n" },
      complete: true,
      accept: true,
    },
    {
      slug: "unused-flag",
      title: "Remove the unused debug flag",
      branch: "ensemble/unused-flag",
      files: { "src/flags.ts": "export const debug = false;\nexport const timeoutMs = 5000;\n" },
      edits: { "src/flags.ts": "export const timeoutMs = 5000;\n" },
      complete: true,
      accept: true,
    },
  ];

  for (const spec of specs) {
    const repo = join(root, spec.slug);
    await mkdir(join(repo, "src"), { recursive: true });
    for (const [path, content] of Object.entries(spec.files)) {
      await mkdir(join(repo, path.split("/").slice(0, -1).join("/")), { recursive: true }).catch(() => undefined);
      await writeFile(join(repo, path), content);
    }
    const identity = ["-c", "user.email=seed@ensemble.local", "-c", "user.name=Ensemble Seed"];
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["add", "."]);
    await git(repo, [...identity, "commit", "-m", "Initial sample"]);
    const base = (await git(repo, ["rev-parse", "HEAD"])).trim();
    for (const [path, content] of Object.entries(spec.edits)) {
      await writeFile(join(repo, path), content);
    }
    await git(repo, ["checkout", "-b", spec.branch]);

    const work = await task({
      title: spec.title,
      description: "Sample agent change for the Code tab. The diff is a local file, not a GitHub pull request.",
      sourceKind: "manual",
      sourceRef: `seed:review:${spec.slug}`,
      owner: "agent",
      status: spec.complete ? "done" : "waiting_approval",
      priority: "p2",
      complexity: "easy",
      completedAt: spec.complete ? new Date() : undefined,
    });
    const run = await prisma.run.create({
      data: {
        taskId: work.id,
        userId: USER,
        worker: "coder",
        outcome: spec.complete ? "success" : "waiting_approval",
        requestedModel: "gemini-3.5-flash-lite",
        endedAt: spec.complete ? new Date() : null,
        result: spec.complete ? "Reviewed and accepted." : "Waiting for a hunk decision.",
      },
    });
    const job = await prisma.workspaceJob.create({
      data: {
        userId: USER,
        taskId: work.id,
        runId: run.id,
        status: spec.complete ? "succeeded" : "waiting_approval",
        executionMode: "native",
        model: "gemini-3.5-flash-lite",
        instructions: spec.title,
        repoPath: repo,
        branch: spec.branch,
        baseBranch: "main",
        finishedAt: spec.complete ? new Date() : null,
      },
    });
    const review = await prisma.codeReview.create({
      data: {
        userId: USER,
        jobId: job.id,
        repoPath: repo,
        initialHead: base,
        startTree: base,
        endTree: base,
        startCommit: base,
        agentPaths: Object.keys(spec.edits),
        expiresAt: daysFromNow(14),
        completedAt: spec.complete ? new Date() : null,
      },
    });
    if (spec.accept) {
      for (const path of Object.keys(spec.edits)) {
        const text = await git(repo, ["diff", "--no-color", "--no-renames", "-U3", base, "--", path]);
        const diff = parseDiff(path, text);
        for (const hunk of diff.hunks) {
          await prisma.codeReviewDecision.create({
            data: { reviewId: review.id, path, chunkKey: hunk.key, decision: "accepted" },
          });
        }
      }
    }
  }
  return specs.length;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
