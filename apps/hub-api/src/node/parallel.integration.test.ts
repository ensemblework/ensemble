/**
 * Parallel work in one repository end to end (ensemble-node docs/design B13) against an in-memory database
 * with the model scripted and a fake laptop sharing one folder; runs are finished by updating their jobs.
 * Serial work takes turns in the one checkout without asking anyone; worktrees give each build its own
 * worktree and branch, its check runs there, and an integration step brings both in before a final check
 * of the integrated commit; a check is marked stale when a later step leaves another commit in its place;
 * stopping a mission lets go of everything it held or waited for.
 */
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { randomBytes } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

const h = await createHttpHarness();
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns } = await import("./queue.js");
const { pollRuns } = await import("./runs.js");
const { saveSettings } = await import("../lib/settings.js");
const { RunProfile } = await import("@ensemble/shared-types");
const { worktreeBranch, worktreeName } = await import("./parallel.js");
const { claimPort, claimResource, releaseResource, waitForResource } = await import("./claims.js");
after(() => h.close());

type Call = { name: string; arguments: Record<string, unknown> };
type Step = { calls?: Call[]; text?: string; then?: string };
type Seen = { slug: string; transcript: string };
let script: (turn: Seen) => Step = () => ({ text: "ok" });
const seen: Seen[] = [];

setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  const system = messages.filter((row) => row.role === "system").map((row) => String(row.content)).join("\n");
  const slug = /You are .+? \(@([a-z0-9-]+)\), (?:an Ensemble Node|a temporary helper)/.exec(system)?.[1] ?? "?";
  const last = messages.filter((row) => row.role === "user").at(-1)?.content;
  const transcript = Array.isArray(last) ? last.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(last ?? "");
  const second = messages.at(-1)?.role === "tool";
  const current: Seen = { slug, transcript };
  if (!second) seen.push(current);
  const step = script(current);
  const calls = second ? [] : (step.calls ?? []);
  const text = second ? (step.then ?? "Done.") : calls.length ? "" : (step.text ?? "ok");
  const turn: RuntimeTurn = {
    text,
    toolCalls: calls.map((call, index) => ({ id: `call-${randomBytes(4).toString("hex")}-${index}`, name: call.name, arguments: JSON.stringify(call.arguments) })),
    model: "test-model",
    credits: 0,
    tokensIn: 10,
    tokensOut: 5,
    reasoning: "",
    raw: {},
    finishReason: "stop",
    cutOff: false,
  };
  if (text) args.onDelta?.(text);
  return turn;
});

afterEach(async () => {
  await settleTurns();
  seen.length = 0;
});

const json = (response: LightMyRequestResponse) => response.json() as any;

async function person(name: string): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date() } });
  return user;
}

async function laptopFor(user: HttpUser, worktrees = true) {
  const key = await h.asToken(user, "device");
  const laptop = await h.prisma.device.create({
    data: { userId: user.id, name: "Laptop", platform: "linux", tokenId: key.id, capabilities: { folders: ["live-test"], engines: ["claude-code", "codex"], ...(worktrees ? { worktrees: 1 } : {}) }, lastSeenAt: new Date() },
  });
  await saveSettings(h.prisma, user.id, { runProfiles: [RunProfile.parse({ id: "careful", name: "Careful", engine: "claude-code", mode: "ask", delivery: "local", deviceId: laptop.id })], defaultRunProfileId: "careful" });
  return { laptop, key };
}

async function crew(user: HttpUser) {
  const ids: Record<string, string> = {};
  for (const template of ["manager", "feature-engineer", "tester"]) {
    const response = await user.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: template } });
    assert.equal(response.statusCode, 201, response.body);
    ids[template] = json(response).node.id;
  }
  const made = await user.inject({ method: "POST", url: "/api/node/crews", payload: { title: `Crew ${randomBytes(3).toString("hex")}`, nodeIds: Object.values(ids), leadNodeId: ids.manager } });
  assert.equal(made.statusCode, 201, made.body);
  return { ids, room: json(made).room as { id: string } };
}

const FOLDER = "~/ensemble-workspace/live-test";
const requirements = [
  { id: "R1", text: "Dark mode", acceptance: [{ id: "A1", text: "The theme switch works" }] },
  { id: "R2", text: "Search", acceptance: [{ id: "A2", text: "Search finds a record by title" }] },
];
const builds = [
  { id: "dark", to: "builder", kind: "build", requirementIds: ["R1"], brief: "Add dark mode." },
  { id: "search", to: "builder", kind: "build", requirementIds: ["R2"], brief: "Add search." },
  { id: "check-dark", to: "tester", kind: "verify", requirementIds: ["R1"], brief: "Check dark mode.", after: ["dark"], verifies: "dark" },
  { id: "check-search", to: "tester", kind: "verify", requirementIds: ["R2"], brief: "Check search.", after: ["search"], verifies: "search" },
];

async function post(user: HttpUser, roomId: string, body: string) {
  const response = await user.inject({ method: "POST", url: `/api/node/rooms/${roomId}/messages`, payload: { body } });
  assert.equal(response.statusCode, 201, response.body);
  await settleTurns();
}

/** Plans `plan` when the owner asks, and reports with `report` when it has nothing left to run. */
function planScript(plan: Record<string, unknown>, report = "Done."): (turn: Seen) => Step {
  return (turn) => {
    if (turn.slug === "manager" && turn.transcript.includes("Please build")) return { calls: [{ name: "node_plan", arguments: plan }], then: "Planned." };
    if (turn.slug === "manager" && turn.transcript.includes("nothing left to run")) return { text: report };
    return { text: "(no reply)" };
  };
}

async function steps(missionId: string) {
  const rows = await h.prisma.nodeStep.findMany({ where: { missionId }, orderBy: { position: "asc" } });
  return Object.fromEntries(rows.map((row) => [row.brief.split(".")[0]!.toLowerCase().replace(/ /g, "-"), row])) as Record<string, (typeof rows)[number]>;
}

/** The runs of a step, oldest first, with what the agent is told (its task's description and instructions). */
async function runsOf(missionId: string, stepId: string) {
  const runs = await h.prisma.nodeRun.findMany({ where: { planId: missionId, planStep: stepId }, orderBy: { createdAt: "asc" } });
  return Promise.all(
    runs.map(async (run) => {
      const row = await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: run.jobId }, include: { task: { select: { description: true } } } });
      return { run, job: { ...row, told: [row.task?.description, row.instructions].filter(Boolean).join("\n\n") } };
    }),
  );
}

async function only(missionId: string, stepId: string) {
  const runs = await runsOf(missionId, stepId);
  assert.equal(runs.length, 1, `one run for ${stepId}`);
  return runs[0]!;
}

async function finish(jobId: string, report: Record<string, unknown>) {
  await h.prisma.workspaceJob.update({ where: { id: jobId }, data: { status: "succeeded", summary: String(report.summary), startedAt: new Date(), finishedAt: new Date(), report: report as never } });
  await pollRuns(h.app);
  await settleTurns();
}

const contextOf = (job: { context: unknown }) => job.context as { mission?: { id?: string; step?: string; worktree?: { name: string; branch?: string; detached?: boolean; reuse?: boolean }; port?: number; integrates?: string[] } };
const needsMe = async (userId: string) => (await h.prisma.nodeMessage.count({ where: { userId, kind: "approval" } })) + (await h.prisma.agentDecision.count({ where: { userId } }));

test("serial: the second build waits for the checkout and starts when the first ends; nobody is asked", async () => {
  const mira = await person("Mira");
  await laptopFor(mira);
  const { room } = await crew(mira);
  script = planScript({ goal: "Dark mode and search", requirements, constraints: { folder: FOLDER, publish: "commit", agent: "codex" }, steps: builds });
  await post(mira, room.id, "Please build dark mode and search, each checked.");
  const mission = await h.prisma.nodeMission.findFirstOrThrow({ where: { originRoomId: room.id } });
  let s = await steps(mission.id);

  const dark = await only(mission.id, s["add-dark-mode"]!.id);
  assert.equal(await h.prisma.nodeRun.count({ where: { planId: mission.id, planStep: s["add-search"]!.id } }), 0, "the second build has not started");
  assert.equal(s["add-search"]!.status, "working");
  assert.match(s["add-search"]!.progress ?? "", /^Waiting for @builder's step to finish with live-test\.$/);
  assert.deepEqual(dark.job.resourceKeys, ["label:live-test"]);
  assert.equal(contextOf(dark.job).mission?.worktree, undefined, "serial work stays in the checkout");
  assert.equal(contextOf(dark.job).mission?.port, undefined, "and gets no port");
  assert.equal(await h.prisma.resourceClaim.count({ where: { missionId: mission.id, kind: "checkout", state: "waiting" } }), 1);

  await finish(dark.job.id, { outcome: "done", summary: "Dark mode.", subject: { commit: "aaa1111" } });
  s = await steps(mission.id);
  const search = await only(mission.id, s["add-search"]!.id);
  assert.equal(search.run.sessionId, dark.run.sessionId, "the builder's next feature continues its session, as before");
  assert.equal(await h.prisma.nodeRun.count({ where: { planId: mission.id, planStep: s["check-dark-mode"]!.id } }), 0, "the check of the first waits in line behind the second build");
  assert.match(s["check-dark-mode"]!.progress ?? "", /Waiting for @builder's step to finish with live-test/);

  await finish(search.job.id, { outcome: "done", summary: "Search.", subject: { commit: "bbb2222" } });
  s = await steps(mission.id);
  const checkDark = await only(mission.id, s["check-dark-mode"]!.id);
  assert.match(s["check-search"]!.progress ?? "", /Waiting for @tester's step to finish with live-test/);
  await finish(checkDark.job.id, { outcome: "pass", summary: "Dark ok.", checks: [{ id: "A1", name: "theme switch", verdict: "pass" }], subject: { commit: "bbb2222" } });
  const checkSearch = await only(mission.id, (await steps(mission.id))["check-search"]!.id);
  await finish(checkSearch.job.id, { outcome: "pass", summary: "Search ok.", checks: [{ id: "A2", name: "search by title", verdict: "pass" }], subject: { commit: "bbb2222" } });

  assert.equal((await h.prisma.nodeMission.findUniqueOrThrow({ where: { id: mission.id } })).status, "succeeded");
  assert.equal(await needsMe(mira.id), 0, "no card, no question");
  assert.equal(await h.prisma.resourceClaim.count({ where: { missionId: mission.id } }), 0, "everything it held is let go");
  assert.deepEqual(seen.map((turn) => turn.slug), ["manager", "manager"], "only the lead thought");
});

test("worktrees: two builds start at once in their own worktrees, each check verifies its branch's commit, and the integration and its check follow", async () => {
  const mira = await person("Mira");
  const { key } = await laptopFor(mira);
  const { room } = await crew(mira);
  const plan = {
    goal: "Dark mode and search, side by side",
    requirements,
    constraints: { folder: FOLDER, branch: "live-testing", publish: "commit", agent: "codex", parallel: "worktrees" },
    steps: [
      ...builds,
      { id: "bring", to: "builder", kind: "build", requirementIds: ["R1", "R2"], brief: "Integrate both features.", integrates: ["dark", "search"], after: ["check-dark", "check-search"] },
      { id: "final", to: "tester", kind: "verify", requirementIds: ["R1", "R2"], brief: "Check the integrated app.", after: ["bring"], verifies: "bring" },
    ],
  };
  script = planScript(plan, "Both features are in live-testing and checked together.");
  await post(mira, room.id, "Please build dark mode and search at the same time.");
  const mission = await h.prisma.nodeMission.findFirstOrThrow({ where: { originRoomId: room.id } });
  let s = await steps(mission.id);
  const ids = { dark: s["add-dark-mode"]!.id, search: s["add-search"]!.id, bring: s["integrate-both-features"]!.id };

  // Both builds start at once, each in its own worktree on a branch named by the mission.
  const dark = await only(mission.id, ids.dark);
  const search = await only(mission.id, ids.search);
  const trees = [contextOf(dark.job).mission!.worktree!, contextOf(search.job).mission!.worktree!];
  assert.deepEqual(trees[0], { name: worktreeName(FOLDER, mission.id, ids.dark), branch: worktreeBranch({ branch: "live-testing" }, mission.id, ids.dark) });
  assert.match(trees[0]!.branch!, new RegExp(`^live-testing-${mission.id.slice(0, 8)}/${ids.dark}$`));
  assert.notEqual(trees[0]!.branch, trees[1]!.branch);
  assert.notEqual(dark.run.sessionId, search.run.sessionId, "each build has its own session");
  assert.deepEqual(dark.job.resourceKeys, [`worktree:${trees[0]!.name}`], "the queue holds it only for its own worktree");
  const ports = [contextOf(dark.job).mission!.port, contextOf(search.job).mission!.port];
  assert.ok(ports[0] && ports[1] && ports[0] !== ports[1], "each has its own port");
  assert.match(dark.job.told, new RegExp(`your own git worktree of ${FOLDER}, “${trees[0]!.name}”, on the local branch ${trees[0]!.branch!.replace(/[/]/g, "\\/")}`));
  assert.match(dark.job.told, new RegExp(`use port ${ports[0]}`));
  assert.equal(dark.job.told.split("Parallel work:").length, 2, "the strategy is said once");

  // The computer claims both at once, and the claim names the worktree.
  const first = json(await key.inject({ method: "POST", url: "/api/devices/self/claim" }));
  const second = json(await key.inject({ method: "POST", url: "/api/devices/self/claim" }));
  assert.deepEqual(new Set([first.id, second.id]), new Set([dark.job.id, search.job.id]));
  assert.deepEqual(first.mission.worktree, contextOf(first.id === dark.job.id ? dark.job : search.job).mission!.worktree);

  await finish(dark.job.id, { outcome: "done", summary: "Dark mode.", subject: { branch: trees[0]!.branch, commit: "aaa1111" } });
  const checkDark = await only(mission.id, s["check-dark-mode"]!.id);
  assert.deepEqual(contextOf(checkDark.job).mission!.worktree, { ...trees[0], reuse: true }, "the check runs in the build's worktree");
  assert.match(checkDark.job.told, new RegExp(`independently, at commit aaa1111 on ${trees[0]!.branch!.replace(/[/]/g, "\\/")}`));
  assert.match(checkDark.job.told, /Where you check: @builder's git worktree/);

  await finish(search.job.id, { outcome: "done", summary: "Search.", subject: { branch: trees[1]!.branch, commit: "bbb2222" } });
  const checkSearch = await only(mission.id, s["check-search"]!.id);
  assert.match(checkSearch.job.told, /independently, at commit bbb2222/);
  assert.equal(await h.prisma.nodeRun.count({ where: { planId: mission.id, planStep: ids.bring } }), 0, "integration waits for both checks");

  await finish(checkDark.job.id, { outcome: "pass", summary: "Dark ok.", checks: [{ id: "A1", name: "theme switch", verdict: "pass", rerun: { command: "npm test -- theme", expects: "exit_0" } }], subject: { commit: "aaa1111" } });
  await finish(checkSearch.job.id, { outcome: "pass", summary: "Search ok.", checks: [{ id: "A2", name: "search by title", verdict: "pass" }], subject: { commit: "bbb2222" } });

  // The integration names both candidates and how to combine them, and works in the folder itself.
  const bring = await only(mission.id, ids.bring);
  for (const part of [`branch ${trees[0]!.branch} (worktree “${trees[0]!.name}”), commit aaa1111`, `branch ${trees[1]!.branch} (worktree “${trees[1]!.name}”), commit bbb2222`, "git merge --no-ff", "npm test -- theme", "Integrate both features."]) {
    assert.ok(bring.job.told.includes(part), `the integration is told “${part}”`);
  }
  assert.deepEqual(bring.job.resourceKeys, ["label:live-test"]);
  assert.equal(contextOf(bring.job).mission!.worktree, undefined);
  assert.deepEqual(contextOf(bring.job).mission!.integrates, [trees[0]!.name, trees[1]!.name], "the computer removes them after it succeeds");

  await finish(bring.job.id, { outcome: "done", summary: "Merged both.", subject: { branch: "live-testing", commit: "ccc3333" } });
  s = await steps(mission.id);
  const final = await only(mission.id, s["check-the-integrated-app"]!.id);
  assert.match(final.job.told, /independently, at commit ccc3333 on live-testing/, "the last check verifies the integrated commit");
  await finish(final.job.id, { outcome: "pass", summary: "All good together.", checks: [{ id: "A1", name: "theme switch", verdict: "pass" }, { id: "A2", name: "search by title", verdict: "pass" }], subject: { commit: "ccc3333" } });

  const ended = await h.prisma.nodeMission.findUniqueOrThrow({ where: { id: mission.id } });
  assert.equal(ended.status, "succeeded");
  const card = await h.prisma.nodeMessage.findUniqueOrThrow({ where: { id: mission.id } });
  const shown = (card.data as { steps: Array<{ id: string; integrates?: string[]; staleAfter?: unknown }> }).steps;
  assert.deepEqual(shown.find((row) => row.id === ids.bring)?.integrates, [ids.dark, ids.search]);
  assert.ok(shown.every((row) => !row.staleAfter), "integration happens in the checkout: the worktrees' checks still hold for their branches");
  assert.equal(await h.prisma.resourceClaim.count({ where: { missionId: mission.id } }), 0);
  assert.equal(await needsMe(mira.id), 0);
});

test("a check is stale when a later step leaves another commit in its place, and the lead's report says so", async () => {
  const mira = await person("Mira");
  await laptopFor(mira);
  const { room } = await crew(mira);
  const plan = {
    goal: "Dark mode, documented",
    requirements: [requirements[0]!],
    constraints: { folder: FOLDER, publish: "commit", agent: "codex" },
    steps: [builds[0]!, builds[2]!, { id: "docs", to: "builder", kind: "write", requirementIds: ["R1"], brief: "Document dark mode.", after: ["check-dark"] }],
  };
  script = planScript(plan, "Dark mode is in and documented; its check was before the docs commit.");
  await post(mira, room.id, "Please build dark mode and document it.");
  const mission = await h.prisma.nodeMission.findFirstOrThrow({ where: { originRoomId: room.id } });
  let s = await steps(mission.id);
  await finish((await only(mission.id, s["add-dark-mode"]!.id)).job.id, { outcome: "done", summary: "Dark mode.", subject: { commit: "aaa1111" } });
  await finish((await only(mission.id, s["check-dark-mode"]!.id)).job.id, { outcome: "pass", summary: "Dark ok.", checks: [{ id: "A1", name: "theme switch", verdict: "pass" }], subject: { commit: "aaa1111" } });
  s = await steps(mission.id);
  await finish((await only(mission.id, s["document-dark-mode"]!.id)).job.id, { outcome: "done", summary: "Docs.", subject: { commit: "ddd4444" } });

  const card = await h.prisma.nodeMessage.findUniqueOrThrow({ where: { id: mission.id } });
  const check = (card.data as { steps: Array<{ id: string; staleAfter?: { step: string; handle: string; candidate: string } }> }).steps.find((row) => row.id === s["check-dark-mode"]!.id);
  assert.deepEqual({ ...check?.staleAfter, at: undefined }, { step: s["document-dark-mode"]!.id, handle: "builder", candidate: "ddd4444", at: undefined });
  const report = seen.find((turn) => turn.slug === "manager" && turn.transcript.includes("nothing left to run"));
  assert.match(report?.transcript ?? "", /@tester's check passed for aaa1111, but @builder's step then left ddd4444 in the same place: that pass does not cover it\./);
});

test("stopping a mission lets go of what it held and of its place in line; an older computer builds in the checkout, one at a time", async () => {
  const mira = await person("Mira");
  await laptopFor(mira, false);
  const { room } = await crew(mira);
  const plan = {
    goal: "Two features",
    requirements,
    constraints: { folder: FOLDER, publish: "commit", agent: "codex", parallel: "worktrees" },
    steps: [
      ...builds,
      { id: "bring", to: "builder", kind: "build", requirementIds: ["R1", "R2"], brief: "Integrate both features.", integrates: ["dark", "search"], after: ["check-dark", "check-search"] },
      { id: "final", to: "tester", kind: "verify", requirementIds: ["R1", "R2"], brief: "Check the integrated app.", after: ["bring"], verifies: "bring" },
    ],
  };
  script = planScript(plan);
  await post(mira, room.id, "Please build dark mode and search.");
  const mission = await h.prisma.nodeMission.findFirstOrThrow({ where: { originRoomId: room.id } });
  const s = await steps(mission.id);
  const dark = await only(mission.id, s["add-dark-mode"]!.id);
  assert.equal(contextOf(dark.job).mission?.worktree, undefined, "this computer cannot make worktrees");
  assert.match(dark.job.told, /Ensemble on Laptop is too old to make worktrees, so this step works in live-test itself, one step at a time/);
  assert.match(s["add-search"]!.progress ?? "", /Waiting for @builder's step to finish with live-test/);
  assert.deepEqual(
    (await h.prisma.resourceClaim.findMany({ where: { missionId: mission.id, kind: "checkout" }, orderBy: { sequence: "asc" } })).map((row) => [row.stepId, row.state]),
    [[s["add-dark-mode"]!.id, "held"], [s["add-search"]!.id, "waiting"]],
  );

  const stopped = await mira.inject({ method: "POST", url: `/api/node/plans/${mission.id}/stop` });
  assert.equal(stopped.statusCode, 200, stopped.body);
  await settleTurns();
  assert.equal(await h.prisma.resourceClaim.count({ where: { missionId: mission.id } }), 0, "held and waiting claims are gone");
  assert.equal(await h.prisma.nodeRun.count({ where: { planId: mission.id, planStep: s["add-search"]!.id } }), 0, "the waiting build never starts");
  assert.equal((await h.prisma.nodeMission.findUniqueOrThrow({ where: { id: mission.id } })).status, "stopped");
});

test("the claim API (for the browser broker): a second holder waits in line and gets the profile when the first lets go; ports are never shared", async () => {
  const mira = await person("Mira");
  const { laptop } = await laptopFor(mira);
  const profile = { userId: mira.id, kind: "browser_profile" as const, key: `${laptop.id}:default` };
  assert.equal((await claimResource(h.prisma, { ...profile, holder: "browser:one" })).ok, true);
  const settled = <T,>(promise: Promise<T>) => Promise.race([promise.then(() => true), new Promise<boolean>((done) => setTimeout(() => done(false), 120))]);
  const second = waitForResource(h.prisma, { ...profile, holder: "browser:two" }, { pollMs: 20 });
  assert.equal(await settled(second), false, "taken: it waits");
  const third = waitForResource(h.prisma, { ...profile, holder: "browser:three" }, { pollMs: 20 });
  const tab = await claimResource(h.prisma, { userId: mira.id, kind: "browser_tab", key: `${laptop.id}:tab-1`, holder: "browser:three" }, { wait: false });
  assert.equal(tab.ok, true, "a claim blocks only its own resource");
  await releaseResource(h.prisma, "browser:one");
  assert.equal((await second).holder, "browser:two", "the first in line gets it");
  assert.equal(await settled(third), false);
  await releaseResource(h.prisma, "browser:two");
  assert.equal((await third).holder, "browser:three");
  await releaseResource(h.prisma, "browser:three");
  assert.equal(await h.prisma.resourceClaim.count({ where: { key: { startsWith: laptop.id } } }), 0);

  const one = await claimPort(h.prisma, { userId: mira.id, holder: "run:one", scope: laptop.id });
  const two = await claimPort(h.prisma, { userId: mira.id, holder: "run:two", scope: laptop.id });
  assert.ok(one && two && one !== two);
  assert.equal(await claimPort(h.prisma, { userId: mira.id, holder: "run:one", scope: laptop.id }), one, "the same holder keeps its port");
  await releaseResource(h.prisma, "run:one");
  assert.equal(await claimPort(h.prisma, { userId: mira.id, holder: "run:three", scope: laptop.id }), one, "a port let go is handed out again");
});
