/**
 * “@task:Clone a repo — do this on my machine”: the assistant assigns the task to an agent under
 * the person's default run profile (or the one they name), on their paired computer.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createHttpHarness } from "../test/http.js";

const h = await createHttpHarness();
after(() => h.close());
const { Settings, RunProfile } = await import("@ensemble/shared-types");
const { getTool, toolModule } = await import("./registry.js");
const { applyHeldCalls } = await import("./apply.js");
const { holdsAssistantWrite } = await import("./agent.js");
const { saveSettings, loadSettings } = await import("../lib/settings.js");
const { sha256 } = await import("../lib/auth.js");
type ToolContext = import("./types.js").ToolContext;

const app = { prisma: h.prisma, log: { error() {}, info() {}, warn() {} } } as unknown as FastifyInstance;

async function computer(userId: string, name: string, seen: Date | null, folders: string[] = []) {
  const token = await h.prisma.apiToken.create({
    data: { userId, name: `Device · ${name}`, tokenHash: sha256(`ens_${randomBytes(8).toString("hex")}`), prefix: "ens_test", scope: "device" },
  });
  return h.prisma.device.create({ data: { userId, name, platform: "macos", tokenId: token.id, capabilities: { folders }, lastSeenAt: seen } });
}

async function setup() {
  const user = await h.asUser();
  const laptop = await computer(user.id, "Chinmay's MacBook Pro", new Date(), ["Papers"]);
  const office = await computer(user.id, "Office Mac", null);
  const careful = RunProfile.parse({ id: "careful", name: "Careful", engine: "claude-code", mode: "ask", delivery: "local", deviceId: laptop.id });
  const away = RunProfile.parse({ id: "away", name: "Away", engine: "codex", mode: "unattended", delivery: "commit", deviceId: office.id });
  const third = RunProfile.parse({ id: "third", name: "Research", kind: "research", engine: "ensemble" });
  await saveSettings(h.prisma, user.id, { runProfiles: [careful, away, third], defaultRunProfileId: "careful" });
  const task = await h.prisma.task.create({ data: { userId: user.id, title: "Clone a repo", boardOrder: 0, createdBy: "me" } });
  const settings = await loadSettings(h.prisma, user.id);
  const ctx: ToolContext = { app, prisma: h.prisma, userId: user.id, actor: "agent", settings };
  return { user, laptop, office, task, ctx };
}

test("with no profile named, the default profile's agent and computer get the task, after Apply", async () => {
  const { laptop, task, ctx } = await setup();
  const tool = getTool("hub_assign_to_agent");
  assert.ok(tool?.prepare && tool.preview);
  assert.equal(toolModule(tool), "workspace");
  assert.equal(holdsAssistantWrite("immediate", tool.name, false, tool.area, tool.alwaysHold), true, "starting work on a computer always waits for Apply");

  const input = await tool.prepare(ctx, tool.input.parse({ taskId: task.id, computer: "any", repoUrl: "https://github.com/MCG-NJU/SportsMOT.git", instructions: "Clone it and summarise the README on the task page." }));
  assert.equal((input as { profile: string }).profile, "careful");
  assert.equal((input as { computer: string }).computer, laptop.id);
  const preview = await tool.preview(ctx, input);
  assert.match(preview, /^Assign “Clone a repo” to Claude Code on Chinmay's MacBook Pro, in a fresh clone of https:\/\/github.com\/MCG-NJU\/SportsMOT.git · profile Careful: Ask/);

  const batch = await applyHeldCalls(app, ctx, [{ tool, input }]);
  assert.ok(batch.outcomes[0]!.ok, JSON.stringify(batch.outcomes[0]));
  const job = await h.prisma.workspaceJob.findFirstOrThrow({ where: { taskId: task.id } });
  assert.equal(job.deviceId, laptop.id);
  assert.equal(job.provider, "claude-code");
  assert.equal((await h.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).owner, "agent");
});

test("a named profile wins, a named computer wins over the profile's, and unknown names are refused with the real ones", async () => {
  const { laptop, office, task, ctx } = await setup();
  const tool = getTool("hub_assign_to_agent")!;
  const away = await tool.prepare!(ctx, tool.input.parse({ taskId: task.id, profile: "away profile" }));
  assert.equal((away as { profile: string }).profile, "away");
  assert.equal((away as { computer: string }).computer, office.id);
  assert.match(await tool.preview!(ctx, away), /to Codex on Office Mac \(offline now: it starts when that computer is back\) · profile Away: Run unattended/);

  const moved = await tool.prepare!(ctx, tool.input.parse({ taskId: task.id, profile: "Away", computer: "macbook" }));
  assert.equal((moved as { computer: string }).computer, laptop.id);

  await assert.rejects(() => tool.prepare!(ctx, tool.input.parse({ taskId: task.id, profile: "Turbo" })), /no run profile called “Turbo”.*“Careful”, “Away”, “Research”/);
  await assert.rejects(() => tool.prepare!(ctx, tool.input.parse({ taskId: task.id, computer: "Studio" })), /No paired computer is called “Studio”/);
  await assert.rejects(() => tool.prepare!(ctx, tool.input.parse({ taskId: task.id, folder: "Secrets" })), /no shared folder called “Secrets”.*“Papers”/);
});

test("the options list marks the default profile and the computers", async () => {
  const { ctx } = await setup();
  const list = getTool("hub_list_agent_options")!;
  const result = (await list.run(ctx, {})).data as { profiles: Array<{ name: string; default: boolean; computer: string | null }>; computers: Array<{ name: string; online: boolean; folders: string[] }> };
  assert.deepEqual(result.profiles.map((row) => [row.name, row.default]), [["Careful", true], ["Away", false], ["Research", false]]);
  assert.equal(result.profiles[0]!.computer, "Chinmay's MacBook Pro");
  assert.deepEqual(result.computers.map((row) => [row.name, row.online]), [["Chinmay's MacBook Pro", true], ["Office Mac", false]]);
});

test("without a marked default the first saved profile is the default, everywhere", () => {
  const first = RunProfile.parse({ id: "a", name: "First" });
  const second = RunProfile.parse({ id: "b", name: "Second" });
  const settings = Settings.parse({ runProfiles: [first, second] });
  const ctx = { settings } as ToolContext;
  return import("./tools/agent-assign.js").then(({ chooseProfile }) => {
    assert.equal(chooseProfile(ctx).id, "a");
    assert.equal(chooseProfile({ settings: Settings.parse({ runProfiles: [first, second], defaultRunProfileId: "b" }) } as ToolContext).id, "b");
    assert.equal(chooseProfile({ settings: Settings.parse({}) } as ToolContext).id, "quick");
  });
});
