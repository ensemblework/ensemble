/**
 * Branch desk demo for Fieldnote's Relay product.
 *
 *   pnpm seed:demo
 *   pnpm seed:demo -- --user you@example.com
 *   pnpm seed:demo -- --remove
 *
 * Re-running replaces rows tagged demo: and rebuilds the local checkouts
 * under ENSEMBLE_WORKSPACE_ROOT. Other engineer desks are not seeded.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDiagram } from "@ensemble/block-diagrams";
import { FULL_MODULE_SET } from "@ensemble/shared-types";
import { ensureLocalDatabase } from "../scripts/ensure-local-db.mjs";
import { env } from "../src/config.js";
import { hashPassword } from "../src/lib/auth.js";
import { expandHome } from "../src/workspace/guard.js";
import { git, parseDiff } from "../src/lib/git.js";
import { prisma } from "../src/lib/prisma.js";
import { estimateUsd } from "../src/lib/pricing.js";
import { saveSettings } from "../src/lib/settings.js";

type Pack = {
  desk: string;
  account: { email: string; name: string; password: string; signupTemplate: string; marketTemplate: string };
  timezone: string;
  people: Array<{ upn: string; name: string; email: string; role: string; team: string; weight: number; hours: number; capacity: number }>;
  repos: Array<{ fullName: string; url: string; description: string; languages: string[]; role: "owner" | "maintainer" | "contributor"; branch: string }>;
  projects: Array<{ key: string; name: string; summary: string; people: string[]; roles: string[]; repos: string[] }>;
  deliverables: Array<{ ref: string; project: string; title: string; status: "upcoming" | "completed"; dueOffsetDays?: number; completedOffsetDays?: number; notes: string }>;
  tasks: Array<{ ref: string; title: string; description: string; status: "waiting_approval" | "in_progress" | "blocked" | "todo" | "proposed" | "done" | "dropped"; owner: "me" | "agent" | "unassigned"; priority: "p0" | "p1" | "p2"; type: string; project: string; repo?: string; dueOffsetDays?: number; completedOffsetDays?: number; deleted?: boolean }>;
  skills: Array<{ slug: string; name: string; description: string; body: string }>;
  meetings: Array<{ title: string; occurredOffsetDays: number; people: string[]; project: string; prompt: string; answer: string; notes: string }>;
  sessions: Array<{ title: string; startedHoursAgo: number; notes: string; recap: string }>;
  notifications: Array<{ title: string; body: string; urgent: boolean; hoursAgo: number; read?: boolean }>;
  deploys: Array<{ name: string; env: string; hoursAgo: number }>;
  tests: Array<{ name: string; build: string; status: string }>;
  metrics: Array<{ title: string; purpose: string; model: string; provider: string; tokensIn: number; tokensOut: number; hoursAgo: number }>;
  diagram: { title: string; source: string };
  checkouts: Array<{ folder: string; branch: string; title: string; taskRef: string; complete: boolean; files: Record<string, string>; edits: Record<string, string> }>;
  approval: { title: string; kind: "open_pr" | "send_email" | "post_teams" | "other"; taskRef: string };
  decision: { title: string; tool: string; command: string };
  chat: { title: string; messages: Array<{ role: string; content: string; model?: string; hoursAgo: number }> };
};

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const removeOnly = args.includes("--remove");
const desk = flag("--desk") ?? "branch";
const email = (flag("--user") ?? "").trim().toLowerCase();

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
const daysFrom = (days: number) => new Date(Date.now() + days * 86_400_000);

async function loadPack(): Promise<Pack> {
  const raw = await readFile(new URL("./demo/branch-desk.json", import.meta.url), "utf8");
  return JSON.parse(raw) as Pack;
}

async function wipe(userId: string, pack: Pack) {
  await prisma.artifact.deleteMany({ where: { userId, externalId: { startsWith: "demo:" } } });
  await prisma.task.deleteMany({ where: { userId, sourceRef: { startsWith: "demo:" } } });
  await prisma.deliverable.deleteMany({ where: { userId, sourceRef: { startsWith: "demo:" } } });
  await prisma.meetingNote.deleteMany({ where: { userId, source: "demo" } });
  await prisma.meetingSession.deleteMany({ where: { userId, title: { in: pack.sessions.map((row) => row.title) } } });
  await prisma.skill.deleteMany({ where: { userId, slug: { in: pack.skills.map((row) => row.slug) } } });
  await prisma.notification.deleteMany({ where: { userId, kind: "demo" } });
  await prisma.metricEvent.deleteMany({ where: { userId, kind: "model.call", payload: { path: ["demo"], equals: "branch" } } });
  await prisma.deployEvent.deleteMany({ where: { userId, name: { in: pack.deploys.map((row) => row.name) } } });
  await prisma.testResult.deleteMany({ where: { userId, name: { in: pack.tests.map((row) => row.name) } } });
  await prisma.blockDiagram.deleteMany({ where: { userId, title: pack.diagram.title } });
  await prisma.agentDecision.deleteMany({ where: { userId, source: "demo" } });
  await prisma.assistantConversation.deleteMany({ where: { userId, title: pack.chat.title } });
  await prisma.$executeRaw`DELETE FROM metric_events WHERE user_id = ${userId} AND payload->>'demo' = 'branch'`;
  await prisma.project.deleteMany({ where: { userId, name: { in: pack.projects.map((row) => row.name) } } });
  await prisma.repo.deleteMany({ where: { userId, fullName: { in: pack.repos.map((row) => row.fullName) } } });
  await prisma.person.deleteMany({ where: { userId, upn: { in: pack.people.map((row) => row.upn) } } });
  const root = join(expandHome(env.ENSEMBLE_WORKSPACE_ROOT), "fieldnote");
  await rm(root, { recursive: true, force: true });
}

async function main() {
  const database = await ensureLocalDatabase();
  if (database.action === "failed") {
    process.exitCode = database.status ?? 1;
    return;
  }
  if (desk !== "branch") {
    throw new Error("Only the branch desk is seeded. Other engineer desks are described in docs/DEMO_DATA.md.");
  }
  const pack = await loadPack();
  const targetEmail = email || pack.account.email;
  let user = await prisma.user.findUnique({ where: { email: targetEmail } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: targetEmail,
        name: targetEmail === pack.account.email ? pack.account.name : targetEmail.split("@")[0] ?? "Engineer",
        passwordHash: await hashPassword(pack.account.password),
      },
    });
  }
  const userId = user.id;
  await wipe(userId, pack);
  if (removeOnly) {
    console.log(`Removed the branch desk demo for ${targetEmail}.`);
    return;
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      onboardingRole: "engineer",
      onboardingTemplateId: pack.account.signupTemplate,
      onboardingCompletedAt: user.onboardingCompletedAt ?? new Date(),
      activeTemplateId: pack.account.marketTemplate,
      moduleSet: FULL_MODULE_SET,
    },
  });
  await saveSettings(prisma, userId, { timezone: pack.timezone, email: targetEmail });
  await prisma.preference.upsert({
    where: { userId_key: { userId, key: "desk.sample" } },
    create: { userId, key: "desk.sample", value: false, source: "me" },
    update: { value: false, source: "me", deletedAt: null },
  });

  const people = new Map<string, string>();
  for (const row of pack.people) {
    const person = await prisma.person.upsert({
      where: { userId_upn: { userId, upn: row.upn } },
      create: {
        userId,
        upn: row.upn,
        name: row.name,
        email: row.email,
        role: row.role,
        team: row.team,
        relationshipWeight: row.weight,
        typicalResponseHours: row.hours,
        capacityHours: row.capacity,
        lastInteraction: hoursAgo(row.hours),
        evidence: ["demo:branch"],
        confidence: 0.9,
      },
      update: {
        name: row.name,
        email: row.email,
        role: row.role,
        team: row.team,
        relationshipWeight: row.weight,
        deletedAt: null,
      },
    });
    people.set(row.upn, person.id);
  }

  const repos = new Map<string, string>();
  for (const row of pack.repos) {
    const repo = await prisma.repo.upsert({
      where: { userId_fullName: { userId, fullName: row.fullName } },
      create: {
        userId,
        fullName: row.fullName,
        url: row.url,
        description: row.description,
        defaultBranch: row.branch,
        languages: row.languages,
        myRole: row.role,
        tracked: true,
        confidence: 0.95,
        evidence: ["demo:branch"],
      },
      update: { description: row.description, tracked: true, deletedAt: null },
    });
    repos.set(row.fullName, repo.id);
  }

  const projects = new Map<string, string>();
  for (const row of pack.projects) {
    const project = await prisma.project.upsert({
      where: { userId_name: { userId, name: row.name } },
      create: { userId, name: row.name, summary: row.summary, createdBy: "me", confidence: 0.95, evidence: ["demo:branch"] },
      update: { summary: row.summary, deletedAt: null, status: "active" },
    });
    projects.set(row.key, project.id);
    for (let i = 0; i < row.people.length; i += 1) {
      const personId = people.get(row.people[i]!);
      if (!personId) continue;
      await prisma.projectPerson.upsert({
        where: { projectId_personId: { projectId: project.id, personId } },
        create: { projectId: project.id, personId, role: row.roles[i] ?? "teammate", addedBy: "me" },
        update: { role: row.roles[i] ?? "teammate" },
      });
    }
    for (const fullName of row.repos) {
      const repoId = repos.get(fullName);
      if (!repoId) continue;
      await prisma.projectRepo.upsert({
        where: { projectId_repoId: { projectId: project.id, repoId } },
        create: { projectId: project.id, repoId, addedBy: "me" },
        update: {},
      });
    }
  }

  for (const row of pack.deliverables) {
    await prisma.deliverable.create({
      data: {
        userId,
        projectId: projects.get(row.project)!,
        title: row.title,
        status: row.status,
        due: row.dueOffsetDays == null ? null : daysFrom(row.dueOffsetDays),
        completedAt: row.status === "completed" ? daysFrom(row.completedOffsetDays ?? -1) : null,
        notes: row.notes,
        sourceRef: row.ref,
        createdBy: "me",
        owner: "Mira Chen",
      },
    });
  }

  const tasks = new Map<string, string>();
  for (const [index, row] of pack.tasks.entries()) {
    const task = await prisma.task.create({
      data: {
        userId,
        title: row.title,
        description: row.description,
        status: row.status,
        owner: row.owner,
        priority: row.priority,
        complexity: row.priority === "p0" ? "high" : "medium",
        complexitySource: "me",
        taskType: row.type,
        sourceKind: "manual",
        sourceRef: row.ref,
        createdBy: "me",
        projectId: projects.get(row.project),
        repoId: row.repo ? repos.get(row.repo) : undefined,
        due: row.dueOffsetDays == null ? null : daysFrom(row.dueOffsetDays),
        completedAt: row.status === "done" ? daysFrom(row.completedOffsetDays ?? 0) : null,
        deletedAt: row.deleted ? hoursAgo(10) : null,
        boardOrder: index,
        people: (row.project === "relay" ? ["samir@fieldnote.dev", "jonah@fieldnote.dev"] : ["leila@fieldnote.dev"])
          .map((upn) => people.get(upn))
          .filter((id): id is string => Boolean(id)),
      },
    });
    tasks.set(row.ref, task.id);
    await prisma.taskTransition.create({
      data: { userId, taskId: task.id, toStatus: row.status, toOwner: row.owner, actor: "me", reason: "Demo desk" },
    });
  }

  const relayId = projects.get("relay");
  const consoleId = projects.get("console");
  const relayRepo = repos.get("fieldnote/relay");
  const demoArtifacts: Array<{
    externalId: string;
    kind: "file" | "pr" | "email";
    title: string;
    text: string;
    url: string;
    source: string;
    projectId?: string;
    repoId?: string;
    taskId?: string;
    daysAgo: number;
  }> = [
    {
      externalId: "demo:artifact-signature-spec",
      kind: "file",
      title: "Webhook signature spec",
      text: "How Relay signs the first attempt and how a retry must reuse that signature.",
      url: "https://github.com/fieldnote/relay/blob/main/docs/signatures.md",
      source: "GitHub",
      projectId: relayId,
      repoId: relayRepo,
      daysAgo: 2,
    },
    {
      externalId: "demo:artifact-pr-128",
      kind: "pr",
      title: "fieldnote/relay #128 · reuse the original signature",
      text: "Retry attempts were minting a new signature. This pull request keeps the first one.",
      url: "https://github.com/fieldnote/relay/pull/128",
      source: "GitHub",
      projectId: relayId,
      repoId: relayRepo,
      taskId: tasks.get("demo:review-sign"),
      daysAgo: 1,
    },
    {
      externalId: "demo:artifact-priya-email",
      kind: "email",
      title: "Re: Friday replay drill",
      text: "Priya Raman asked for the signed retry to land before the Northwind drill.",
      url: "https://mail.example.com/fieldnote/priya-replay",
      source: "Gmail",
      projectId: consoleId,
      daysAgo: 1,
    },
    {
      externalId: "demo:artifact-replay-notes",
      kind: "file",
      title: "Northwind replay notes",
      text: "The partner's checklist for the Friday drill. Not a task.",
      url: "https://docs.example.com/fieldnote/replay-notes",
      source: "Drive",
      projectId: relayId,
      daysAgo: 3,
    },
  ];
  for (const row of demoArtifacts) {
    await prisma.artifact.create({
      data: {
        userId,
        kind: row.kind,
        externalId: row.externalId,
        url: row.url,
        ts: daysFrom(-row.daysAgo),
        title: row.title,
        text: row.text,
        projectId: row.projectId,
        repoId: row.repoId,
        taskId: row.taskId,
        metadata: { source: row.source },
        authoredByMe: false,
      },
    });
  }

  for (const row of pack.skills) {
    await prisma.skill.upsert({
      where: { userId_slug: { userId, slug: row.slug } },
      create: {
        userId,
        slug: row.slug,
        name: row.name,
        description: row.description,
        body: row.body,
        provenance: "declared",
        confidence: 0.8,
        enabled: true,
        evidence: ["demo:branch"],
        lastUsedAt: hoursAgo(6),
      },
      update: { name: row.name, description: row.description, body: row.body, deletedAt: null, enabled: true },
    });
  }

  for (const row of pack.meetings) {
    const when = daysFrom(row.occurredOffsetDays);
    await prisma.meetingNote.create({
      data: {
        userId,
        title: row.title,
        prompt: row.prompt,
        answer: row.answer,
        occurredAt: when,
        personIds: row.people.map((upn) => people.get(upn)!).filter(Boolean),
        projectId: projects.get(row.project),
        comment: row.notes,
        source: "demo",
        status: "ready",
        extraction: {
          summary: row.answer,
          decisions: row.notes.split("\n").filter((line) => /decid|agreed/i.test(line)),
          provider: "google",
          tokensIn: 1680,
          tokensOut: 420,
        },
        extractionModel: "gemini-2.5-flash",
        extractedAt: when,
      },
    });
  }

  for (const row of pack.sessions) {
    const started = hoursAgo(row.startedHoursAgo);
    await prisma.meetingSession.create({
      data: {
        userId,
        title: row.title,
        notes: row.notes,
        recap: row.recap,
        status: "ended",
        attachState: "none",
        personIds: [],
        startedAt: started,
        endedAt: new Date(started.getTime() + 45 * 60_000),
        recapAt: new Date(started.getTime() + 50 * 60_000),
      },
    });
  }

  for (const row of pack.notifications) {
    await prisma.notification.create({
      data: {
        userId,
        kind: "demo",
        title: row.title,
        body: row.body,
        urgent: row.urgent,
        readAt: row.read ? hoursAgo(row.hoursAgo - 1) : null,
        createdAt: hoursAgo(row.hoursAgo),
        url: "/needs-me",
      },
    });
  }

  for (const row of pack.deploys) {
    await prisma.deployEvent.create({ data: { userId, name: row.name, env: row.env, at: hoursAgo(row.hoursAgo) } });
  }
  for (const row of pack.tests) {
    await prisma.testResult.create({ data: { userId, name: row.name, build: row.build, status: row.status } });
  }
  for (const row of pack.metrics) {
    await prisma.metricEvent.create({
      data: {
        userId,
        kind: "model.call",
        ts: hoursAgo(row.hoursAgo),
        seconds: 4.2,
        payload: {
          demo: "branch",
          title: row.title,
          purpose: row.purpose,
          provider: row.provider,
          model: row.model,
          tokensIn: row.tokensIn,
          tokensOut: row.tokensOut,
          estimatedUsd: estimateUsd(row.model, row.tokensIn, row.tokensOut),
        },
      },
    });
  }

  const shapes: Array<[string, string, string, string]> = [
    ["Hub chat", "Ask how a signed replay should look", "gemini-2.5-flash", "google"],
    ["Delegated tasks", "Draft the partner status for Priya", "gemini-2.5-flash", "google"],
    ["Meeting extraction", "Pull the decisions out of the standup", "gemini-2.5-flash", "google"],
    ["Hub chat", "Summarize the dead-letter list", "gemini-2.5-pro", "google"],
    ["Delegated tasks", "Check the retry backoff against the note", "gemini-2.5-flash", "google"],
  ];
  for (let ago = 13; ago >= 0; ago -= 1) {
    const day = new Date(Date.now() - ago * 24 * 60 * 60 * 1000);
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short" }).format(day);
    const weekend = weekday === "Sat" || weekday === "Sun";
    const count = weekend ? 1 : 3 + (ago % 3);
    for (let n = 0; n < count; n += 1) {
      const [purpose, title, model, provider] = shapes[(ago + n) % shapes.length]!;
      const tokensIn = weekend ? 280 + n * 40 : 520 + ((ago * 17 + n * 90) % 2400);
      const tokensOut = weekend ? 70 + n * 15 : 140 + ((ago * 11 + n * 30) % 700);
      const stamp = new Date(day);
      stamp.setUTCHours(16 + n, 8 + n * 6, 0, 0);
      await prisma.metricEvent.create({
        data: {
          userId,
          kind: "model.call",
          ts: stamp,
          seconds: weekend ? 1.4 : 2.8 + n,
          payload: {
            demo: "branch",
            title,
            purpose,
            provider,
            model,
            tokensIn,
            tokensOut,
            estimatedUsd: estimateUsd(model, tokensIn, tokensOut),
          },
        },
      });
    }
  }

  const parsed = parseDiagram(pack.diagram.source);
  if (parsed.diagnostics.length) console.warn(parsed.diagnostics.map((row) => row.message).join("\n"));
  const diagram = await prisma.blockDiagram.create({
    data: { userId, title: pack.diagram.title, source: pack.diagram.source, document: parsed.model as object },
  });
  const relayProject = projects.get("relay");
  if (relayProject) {
    await prisma.diagramLink.create({
      data: { userId, diagramId: diagram.id, targetKind: "project", targetId: relayProject },
    });
  }

  const chat = await prisma.assistantConversation.create({
    data: { userId, title: pack.chat.title, startedOn: new Date().toISOString().slice(0, 10) },
  });
  for (const message of pack.chat.messages) {
    await prisma.assistantMessage.create({
      data: {
        conversationId: chat.id,
        userId,
        role: message.role,
        content: message.content,
        model: message.model,
        createdAt: hoursAgo(message.hoursAgo),
      },
    });
  }

  const reviewRun = await prisma.run.create({
    data: {
      userId,
      taskId: tasks.get(pack.approval.taskRef)!,
      worker: "coder",
      outcome: "waiting_approval",
      requestedModel: "gemini-2.5-pro",
      result: "Signing now happens once. The retry loop only forwards the stored signature.",
      startedAt: hoursAgo(3),
    },
  });
  await prisma.runStep.create({
    data: {
      runId: reviewRun.id,
      index: 0,
      title: "Read the worker and the signer",
      status: "done",
      model: "gemini-2.5-pro",
      tokensIn: 1800,
      tokensOut: 240,
      startedAt: hoursAgo(3),
      endedAt: hoursAgo(2.8),
      output: "signAttempt is called from deliver() on every try. A replay would mint a new timestamp.",
    },
  });
  await prisma.runStep.create({
    data: {
      runId: reviewRun.id,
      index: 1,
      title: "Move signing out of the retry loop",
      status: "done",
      model: "gemini-2.5-pro",
      tokensIn: 2300,
      tokensOut: 660,
      startedAt: hoursAgo(2.7),
      endedAt: hoursAgo(2.2),
      output: "deliver() now takes the signature from the first attempt.",
    },
  });
  await prisma.approval.create({
    data: {
      userId,
      runId: reviewRun.id,
      taskId: tasks.get(pack.approval.taskRef),
      kind: pack.approval.kind,
      title: pack.approval.title,
      preview: { repo: "fieldnote/relay", branch: "ensemble/attempt-signature", base: "main" },
      requestedAt: hoursAgo(2),
    },
  });

  const doneTask = tasks.get("demo:done-budget");
  if (doneTask) {
    const run = await prisma.run.create({
      data: {
        userId,
        taskId: doneTask,
        worker: "coder",
        outcome: "success",
        requestedModel: "gemini-2.5-flash",
        result: "Eight attempts. The wait grows and stops at 15 minutes. The event id does not change.",
        startedAt: hoursAgo(22),
        endedAt: hoursAgo(21.5),
      },
    });
    await prisma.runStep.create({
      data: {
        runId: run.id,
        index: 0,
        title: "Draft the budget Jonah can forward",
        status: "done",
      model: "gemini-2.5-flash",
      tokensIn: 960,
      tokensOut: 310,
      startedAt: hoursAgo(22),
        endedAt: hoursAgo(21.5),
        output: "Cap the backoff at 15 minutes and dead-letter after the eighth miss.",
      },
    });
  }

  await prisma.agentDecision.create({
    data: {
      userId,
      source: "demo",
      event: "beforeShellExecution",
      toolName: pack.decision.tool,
      title: pack.decision.title,
      detail: { command: pack.decision.command },
      cwd: join(expandHome(env.ENSEMBLE_WORKSPACE_ROOT), "fieldnote", "relay"),
      status: "pending",
      expiresAt: daysFrom(1),
      requestedAt: hoursAgo(1),
    },
  });

  await seedCheckouts(userId, pack, tasks);
  console.log(`Branch desk demo is ready for ${targetEmail}.`);
  console.log("Sign in with that email. The demo password is fieldnote-relay when the account was created by this command.");
}

async function seedCheckouts(userId: string, pack: Pack, tasks: Map<string, string>) {
  for (const spec of pack.checkouts) {
    const repo = join(expandHome(env.ENSEMBLE_WORKSPACE_ROOT), spec.folder);
    await mkdir(repo, { recursive: true });
    for (const [path, content] of Object.entries(spec.files)) {
      const file = join(repo, path);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, content);
    }
    const identity = ["-c", "user.email=mira@fieldnote.dev", "-c", "user.name=Mira Chen"];
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["add", "."]);
    await git(repo, [...identity, "commit", "-m", "Relay delivery baseline"]);
    const base = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await git(repo, ["checkout", "-b", spec.branch]);
    for (const [path, content] of Object.entries(spec.edits)) {
      await writeFile(join(repo, path), content);
    }
    const taskId = tasks.get(spec.taskRef);
    if (!taskId) continue;
    const run = await prisma.run.create({
      data: {
        userId,
        taskId,
        worker: "coder",
        outcome: spec.complete ? "success" : "waiting_approval",
        requestedModel: "gemini-2.5-pro",
        endedAt: spec.complete ? hoursAgo(8) : null,
        result: spec.complete ? "Empty state now names Northwind." : "Signature is passed in. Review the worker diff.",
        startedAt: hoursAgo(spec.complete ? 9 : 3),
      },
    });
    const job = await prisma.workspaceJob.create({
      data: {
        userId,
        taskId,
        runId: run.id,
        status: spec.complete ? "succeeded" : "waiting_approval",
        executionMode: "native",
        model: "gemini-2.5-pro",
        instructions: spec.title,
        repoPath: repo,
        branch: spec.branch,
        baseBranch: "main",
        summary: spec.complete ? "Copy updated." : "Signing left the retry loop.",
        finishedAt: spec.complete ? hoursAgo(8) : null,
      },
    });
    const review = await prisma.codeReview.create({
      data: {
        userId,
        jobId: job.id,
        repoPath: repo,
        initialHead: base,
        startTree: base,
        endTree: base,
        startCommit: base,
        agentPaths: Object.keys(spec.edits),
        expiresAt: daysFrom(14),
        completedAt: spec.complete ? hoursAgo(8) : null,
      },
    });
    if (spec.complete) {
      for (const path of Object.keys(spec.edits)) {
        const text = await git(repo, ["diff", "--no-color", "--no-renames", "-U3", base, "--", path]);
        for (const hunk of parseDiff(path, text).hunks) {
          await prisma.codeReviewDecision.create({
            data: { reviewId: review.id, path, chunkKey: hunk.key, decision: "accepted" },
          });
        }
      }
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
