import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { SKILL_LEARNING_MIN_ITEMS } from "@ensemble/shared-types";
import { createHttpHarness, type HttpHarness } from "./http.js";

import type { complete } from "../lib/runtime.js";

const h = await createHttpHarness();
const { claimQueuedJob, NEEDS_ME_GRACE_MS } = await import(
  "../workspace/queue-policy.js"
);
const { runRetention } = await import("../jobs/retention.js");
const { createMorningRoutine } = await import("../routines/service.js");
after(async () => {
  await h?.close();
});

async function owner() {
  const user = await h.asUser();
  await h.prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerifiedAt: new Date(),
      createdAt: new Date(Date.now() - 2 * 86_400_000),
      profession: "Teacher",
    },
  });
  await user.inject({
    method: "PATCH",
    url: "/api/settings",
    payload: { email: user.email },
  });
  return user;
}
const emptyMining: typeof complete = async () => ({
  text: '{"skills":[]}',
  json: { skills: [] },
  model: "fixture",
  tokensIn: 0,
  tokensOut: 0,
});

test("rename is private, survives heartbeat, and offline sign-ins are not offered", async () => {
  const a = await owner(),
    b = await owner();
  const key = await h.asToken(a, "device");
  const device = await h.prisma.device.create({
    data: {
      userId: a.id,
      tokenId: key.id,
      name: "Before",
      platform: "macos",
      lastSeenAt: new Date(),
      capabilities: {
        assistantTurns: 1,
        agents: [
          {
            id: "claude-code",
            via: "app",
            version: "1",
            signedIn: true,
            models: [],
            checkedAt: new Date().toISOString(),
          },
        ],
      },
    },
  });
  assert.equal(
    (
      await b.inject({
        method: "PATCH",
        url: `/api/devices/${device.id}`,
        payload: { name: "Stolen" },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await a.inject({
        method: "PATCH",
        url: `/api/devices/${device.id}`,
        payload: { name: "  Work laptop  " },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await a.inject({
        method: "PATCH",
        url: `/api/devices/${device.id}`,
        payload: { name: " " },
      })
    ).statusCode,
    400,
  );
  const online = await a.inject({ method: "GET", url: "/api/subscriptions" });
  assert.equal(online.json().computers[0].agents.length, 1);
  await h.prisma.device.update({
    where: { id: device.id },
    data: { lastSeenAt: new Date(Date.now() - 120_000) },
  });
  const offline = await a.inject({ method: "GET", url: "/api/subscriptions" });
  assert.equal(offline.json().computers[0].online, false);
  assert.deepEqual(offline.json().computers[0].agents, []);
  assert.equal(
    (
      await a.inject({
        method: "POST",
        url: "/api/subscriptions/check",
        payload: { deviceId: device.id },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await h.prisma.device.findUniqueOrThrow({ where: { id: device.id } }))
      .name,
    "Work laptop",
  );
});

test("all-session legacy settings never capture an unrelated editor prompt", async () => {
  const a = await owner();
  await a.inject({
    method: "PATCH",
    url: "/api/settings",
    payload: { orchestration: { editorRequests: "all" } },
  });
  const res = await a.inject({
    method: "POST",
    url: "/api/decisions",
    payload: {
      source: "claude",
      event: "permission",
      payload: { tool_name: "Bash", session_id: "outside-ensemble" },
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "skipped");
  assert.equal(
    await h.prisma.agentDecision.count({ where: { userId: a.id } }),
    0,
  );
});

test("queue holds Needs me for an hour, permits only N+1, and resumes without losing the slot", async () => {
  const a = await owner();
  await a.inject({
    method: "PATCH",
    url: "/api/settings",
    payload: { orchestration: { maxConcurrentJobs: 1 } },
  });
  const makeJob = async (status: "running" | "queued" | "waiting_approval") => {
    const task = await h.prisma.task.create({
      data: { userId: a.id, title: "Queue fixture", createdBy: "me" },
    });
    return h.prisma.workspaceJob.create({
      data: {
        userId: a.id,
        taskId: task.id,
        status,
        executionMode: "sandbox",
        model: "fixture",
      },
    });
  };
  const held = await makeJob("waiting_approval"),
    next = await makeJob("queued"),
    third = await makeJob("queued");
  const decision = await h.prisma.agentDecision.create({
    data: {
      userId: a.id,
      source: "ensemble",
      event: "question",
      toolName: "Question",
      title: "Which?",
      sessionId: held.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  assert.equal(
    await claimQueuedJob(h.prisma, next.id, { status: "running" }),
    false,
  );
  await h.prisma.agentDecision.update({
    where: { id: decision.id },
    data: { requestedAt: new Date(Date.now() - NEEDS_ME_GRACE_MS - 1) },
  });
  assert.equal(
    await claimQueuedJob(h.prisma, next.id, { status: "running" }),
    true,
  );
  assert.equal(
    await claimQueuedJob(h.prisma, third.id, { status: "running" }),
    false,
  );
  await h.prisma.agentDecision.update({
    where: { id: decision.id },
    data: { status: "decided", decision: "allow" },
  });
  await h.prisma.workspaceJob.update({
    where: { id: held.id },
    data: { status: "running" },
  });
  await h.prisma.workspaceJob.update({
    where: { id: next.id },
    data: { status: "succeeded" },
  });
  assert.equal(
    await claimQueuedJob(h.prisma, third.id, { status: "running" }),
    false,
  );
  await h.prisma.workspaceJob.update({
    where: { id: held.id },
    data: { status: "succeeded" },
  });
  assert.equal(
    await claimQueuedJob(h.prisma, third.id, { status: "running" }),
    true,
  );
});

test("queue claims serialize, and project conflicts hold even when more slots exist", async () => {
  const a = await owner();
  await a.inject({
    method: "PATCH",
    url: "/api/settings",
    payload: { orchestration: { maxConcurrentJobs: 1 } },
  });
  const tasks = await Promise.all(
    [1, 2].map(() =>
      h.prisma.task.create({
        data: { userId: a.id, title: "Race", createdBy: "me" },
      }),
    ),
  );
  const jobs = await Promise.all(
    tasks.map((task) =>
      h.prisma.workspaceJob.create({
        data: {
          userId: a.id,
          taskId: task.id,
          model: "fixture",
          executionMode: "sandbox",
        },
      }),
    ),
  );
  const wins = await Promise.all(
    jobs.map((job) => claimQueuedJob(h.prisma, job.id, { status: "running" })),
  );
  assert.equal(wins.filter(Boolean).length, 1);
  await a.inject({
    method: "PATCH",
    url: "/api/settings",
    payload: { orchestration: { maxConcurrentJobs: 3 } },
  });
  const project = await h.prisma.project.create({
    data: { userId: a.id, name: "One project" },
  });
  await h.prisma.task.updateMany({
    where: { id: { in: tasks.map((row) => row.id) } },
    data: { projectId: project.id },
  });
  assert.equal(
    await claimQueuedJob(h.prisma, jobs[wins[0] ? 1 : 0]!.id, {
      status: "running",
    }),
    false,
  );
});

test("Delete my data erases standalone pages, diagrams, skills and histories, isolates accounts and retains sign-in", async () => {
  const a = await owner(),
    b = await owner();
  const foreign = await h.prisma.task.create({
    data: { userId: b.id, title: "Keep", createdBy: "me" },
  });
  await h.prisma.task.create({
    data: { userId: a.id, title: "Erase", createdBy: "me" },
  });
  const page = await a.inject({
    method: "POST",
    url: "/api/pages",
    payload: { title: "Private note" },
  });
  assert.equal(page.statusCode, 201);
  await h.prisma.blockDiagram.create({
    data: { userId: a.id, title: "Private diagram", source: "" },
  });
  await h.prisma.completionRecord.create({
    data: {
      userId: a.id,
      entityKind: "task",
      entityId: "old",
      title: "Private history",
      outcome: "done",
    },
  });
  assert.equal(
    (
      await a.inject({
        method: "POST",
        url: "/api/data/delete",
        payload: { scope: "everything", confirm: "wrong" },
      })
    ).statusCode,
    400,
  );
  const res = await a.inject({
    method: "POST",
    url: "/api/data/delete",
    payload: { scope: "everything", confirm: "delete everything" },
  });
  assert.equal(res.statusCode, 200, res.body);
  for (const model of [
    h.prisma.task,
    h.prisma.taskPage,
    h.prisma.blockDiagram,
    h.prisma.completionRecord,
  ])
    assert.equal(
      await (model.count as Function)({ where: { userId: a.id } }),
      0,
    );
  assert.ok(await h.prisma.task.findUnique({ where: { id: foreign.id } }));
  assert.equal(
    (await a.inject({ method: "GET", url: "/api/auth/me" })).statusCode,
    200,
  );
});

test("morning brief starts the next local day and its profession instruction is edited as a routine", async () => {
  const a = await owner();
  await a.inject({
    method: "PATCH",
    url: "/api/settings",
    payload: {
      timezone: "Pacific/Kiritimati",
    },
  });
  await h.prisma.user.update({
    where: { id: a.id },
    data: { createdAt: new Date() },
  });
  await h.prisma.$transaction((tx) => createMorningRoutine(tx, a.id));
  const view = await a.inject({ method: "GET", url: "/api/brief/today" });
  const routine = view.json().routine;
  assert.match(routine.instruction, /classes, lesson preparation/);
  const { zonedParts } = await import("../lib/clock.js");
  assert.ok(zonedParts("Pacific/Kiritimati", new Date(routine.nextRunAt)).date > zonedParts("Pacific/Kiritimati").date);
  const saved = await a.inject({
    method: "PATCH",
    url: `/api/routines/${routine.id}`,
    payload: { instruction: "Three priorities, then my classes." },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().routine.instruction, "Three priorities, then my classes.");
});

test("retention warns a day ahead, uses High, writes skills before Trash, preserves pins and retries failed mining", async () => {
  const a = await owner();
  const now = new Date();
  const completedAt = new Date(now.getTime() - 65 * 86_400_000);
  // Learning starts only once a full batch is past its window.
  const ids: string[] = [];
  for (let index = 1; index <= SKILL_LEARNING_MIN_ITEMS; index += 1) {
    const task = await h.prisma.task.create({
      data: {
        userId: a.id,
        title: `Completed ${index}`,
        status: "done",
        completedAt,
        createdBy: "me",
      },
    });
    ids.push(task.id);
  }
  const kept = () =>
    h.prisma.task.count({ where: { id: { in: ids }, deletedAt: null } });
  await h.prisma.skill.create({
    data: {
      userId: a.id,
      slug: "existing-reports",
      name: "Existing reports",
      body: "Keep the original rule.",
      provenance: "declared",
      versions: { create: { version: 1, body: "Keep the original rule." } },
    },
  });
  const pinned = await h.prisma.task.create({
    data: {
      userId: a.id,
      title: "Pinned",
      status: "done",
      pinned: true,
      completedAt,
      createdBy: "me",
    },
  });
  const options = {
    deletedDays: 30,
    completedDays: 60,
    now,
    miningRun: emptyMining,
  };
  assert.equal(
    (await runRetention(h.app, a.id, options)).completedSoftDeleted,
    0,
  );
  assert.equal(
    await h.prisma.notification.count({
      where: { userId: a.id, kind: "skill_mining" },
    }),
    1,
  );
  const tomorrow = new Date(now.getTime() + 86_400_001);
  await runRetention(h.app, a.id, {
    ...options,
    now: tomorrow,
    miningRun: async () => {
      throw new Error("Offline");
    },
  });
  assert.equal(await kept(), SKILL_LEARNING_MIN_ITEMS);
  let tier = "";
  const result = await runRetention(h.app, a.id, {
    ...options,
    now: tomorrow,
    miningRun: async (args) => {
      tier = args.tier!;
      return {
        text: "",
        json: {
          skills: [
            {
              slug: "concise-reports",
              name: "Concise reports",
              body: "Use short paragraphs.",
            },
            {
              slug: "existing-reports",
              name: "Existing reports",
              body: "Add a short conclusion.",
            },
          ],
        },
        model: "fixture",
        tokensIn: 0,
        tokensOut: 0,
      };
    },
  });
  assert.equal(tier, "high");
  const updated = await h.prisma.skill.findFirstOrThrow({
    where: { userId: a.id, slug: "existing-reports" },
    include: { versions: true },
  });
  assert.equal(updated.version, 2);
  assert.match(updated.body, /original rule/);
  assert.match(updated.body, /short conclusion/);
  assert.equal(updated.versions.length, 2);
  assert.equal(result.completedSoftDeleted, SKILL_LEARNING_MIN_ITEMS);
  assert.equal(await kept(), 0);
  assert.equal(
    (
      await h.prisma.skill.findFirstOrThrow({
        where: { userId: a.id, slug: "concise-reports" },
      })
    ).provenance,
    "mined",
  );
  assert.equal(
    (await h.prisma.task.findUniqueOrThrow({ where: { id: pinned.id } }))
      .deletedAt,
    null,
  );
});

test("skill preferences are isolated and previews validate ownership and verification before calling models", async () => {
  const a = await owner(),
    b = await owner();
  const mine = await a.inject({ method: "POST", url: "/api/skills", payload: { name: "Class notes", body: "Start with classes." } });
  const theirs = await b.inject({ method: "POST", url: "/api/skills", payload: { name: "Class notes", body: "Start with classes." } });
  assert.notEqual(mine.json().skill.id, theirs.json().skill.id);
  assert.equal(
    (
      await a.inject({
        method: "PATCH",
        url: `/api/skills/${mine.json().skill.id}`,
        payload: { body: "Only my lessons." },
      })
    ).statusCode,
    200,
  );
  const unchanged = await b.inject({ method: "GET", url: `/api/skills/${theirs.json().skill.id}` });
  assert.doesNotMatch(unchanged.json().skill.body, /Only my lessons/);
  assert.equal(
    (
      await a.inject({
        method: "PATCH",
        url: `/api/skills/${mine.json().skill.id}`,
        payload: { name: "" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await a.inject({
        method: "POST",
        url: `/api/skills/${theirs.json().skill.id}/test`,
        payload: {},
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await a.inject({
        method: "POST",
        url: `/api/skills/${mine.json().skill.id}/test`,
        payload: { prompt: false },
      })
    ).statusCode,
    400,
  );
  const unverified = await h.asUser();
  const previousMode = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.equal(
      (
        await unverified.inject({
          method: "POST",
          url: `/api/skills/${mine.json().skill.id}/test`,
          payload: {},
        })
      ).statusCode,
      403,
    );
  } finally {
    if (previousMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousMode;
  }
});

test("one unanswered question starts only one extra task and waits for the queue to drain", async () => {
  const a = await owner();
  await a.inject({
    method: "PATCH",
    url: "/api/settings",
    payload: { orchestration: { maxConcurrentJobs: 1 } },
  });
  const jobs = [];
  for (const status of ["waiting_approval", "queued", "queued"] as const) {
    const task = await h.prisma.task.create({
      data: { userId: a.id, title: "Overflow", createdBy: "me" },
    });
    jobs.push(
      await h.prisma.workspaceJob.create({
        data: {
          userId: a.id,
          taskId: task.id,
          executionMode: "sandbox",
          model: "fixture",
          status,
        },
      }),
    );
  }
  await h.prisma.agentDecision.create({
    data: {
      userId: a.id,
      source: "ensemble",
      event: "question",
      toolName: "Question",
      title: "Waiting",
      sessionId: jobs[0]!.id,
      requestedAt: new Date(Date.now() - NEEDS_ME_GRACE_MS - 1),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  assert.equal(
    await claimQueuedJob(h.prisma, jobs[1]!.id, { status: "running" }),
    true,
  );
  await h.prisma.workspaceJob.update({
    where: { id: jobs[1]!.id },
    data: { status: "succeeded" },
  });
  assert.equal(
    await claimQueuedJob(h.prisma, jobs[2]!.id, { status: "running" }),
    false,
  );
  await h.prisma.workspaceJob.update({
    where: { id: jobs[0]!.id },
    data: { status: "succeeded" },
  });
  assert.equal(
    await claimQueuedJob(h.prisma, jobs[2]!.id, { status: "running" }),
    true,
  );
});

test("Everything erasure removes the morning routine without recreating it on a read", async () => {
  const a = await owner();
  await h.prisma.$transaction((tx) => createMorningRoutine(tx, a.id));
  const { deleteWorkspaceData } = await import("../lib/workspace-data.js");
  await deleteWorkspaceData(h.prisma, a.id, "everything");
  const result = await a.inject({ method: "GET", url: "/api/brief/today" });
  assert.equal(result.json().routine, null);
  assert.equal(
    await h.prisma.notification.count({ where: { userId: a.id } }),
    0,
  );
});

test("jobs for the same repository wait even when their work folders differ", async () => {
  const a = await owner();
  const tasks = await Promise.all(
    [1, 2].map(() =>
      h.prisma.task.create({
        data: { userId: a.id, title: "One repo", createdBy: "me" },
      }),
    ),
  );
  const jobs = await Promise.all(
    tasks.map((task, index) =>
      h.prisma.workspaceJob.create({
        data: {
          userId: a.id,
          taskId: task.id,
          executionMode: "sandbox",
          model: "fixture",
          repoUrl:
            index === 0
              ? "https://github.com/fictional/project.git"
              : "git@github.com:fictional/project.git",
          resourceKeys: [`dir:/work/${index}`],
        },
      }),
    ),
  );
  assert.equal(
    await claimQueuedJob(h.prisma, jobs[0]!.id, { status: "running" }),
    true,
  );
  assert.equal(
    await claimQueuedJob(h.prisma, jobs[1]!.id, { status: "running" }),
    false,
  );
});
