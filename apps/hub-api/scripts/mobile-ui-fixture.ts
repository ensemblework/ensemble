import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { ONBOARDING_TOUR_KEY, READY_ONBOARDING_TOUR } from "@ensemble/shared-types";
import { createHttpHarness } from "../src/test/http.js";

const port = Number(process.env.MOBILE_API_PORT ?? 4092);
process.env.HUB_WEB_ORIGIN = process.env.HUB_WEB ?? "http://localhost:3092";
process.env.ENSEMBLE_NODE_WEB_ORIGIN = process.env.NODE_WEB ?? "http://localhost:3392";
const h = await createHttpHarness();
const user = await h.asUser("mobile-ui@fieldnote.example");
const request = async (url: string, payload: Record<string, unknown>) => {
  const response = await user.inject({ method: "POST", url, payload });
  assert.ok(response.statusCode < 300, `${url}: ${response.body}`);
  return response.json();
};
await request("/api/onboarding", { role: "engineer", templateId: "branch-desk" });
await h.prisma.user.update({ where: { id: user.id }, data: { profileCompletedAt: new Date(), emailVerifiedAt: new Date() } });
await h.prisma.preference.upsert({
  where: { userId_key: { userId: user.id, key: ONBOARDING_TOUR_KEY } },
  create: { userId: user.id, key: ONBOARDING_TOUR_KEY, value: { ...READY_ONBOARDING_TOUR, status: "completed" } },
  update: {},
});
for (let index = 0; index < 12; index++) {
  await request("/api/people", { name: `Research collaborator ${index} ${"LongName".repeat(6)}`, email: `person${index}@fieldnote.example` });
  await request("/api/projects", { name: `Mobile project ${index} ${"LongTitle".repeat(8)}` });
}
const { node, room } = await request("/api/node/nodes", { name: "Mobile research assistant with a long name", role: "Research and implementation" });
const token = await h.asToken(user, "device");
const device = await h.prisma.device.create({ data: {
  userId: user.id, tokenId: token.id, name: "Fieldnote-development-computer-with-a-long-name", platform: "linux",
  lastSeenAt: new Date(), capabilities: { code: true, browseFiles: true, webEdit: true, webTerminal: true, codeApi: 2, folders: ["mobile-project"] },
} });
const { task } = await request("/api/tasks", { title: "Plan and implement mobile usability across the workspace and every run", status: "todo" });
const job = await h.prisma.workspaceJob.create({ data: {
  userId: user.id, taskId: task.id, deviceId: device.id, kind: "code", status: "running", executionMode: "sandbox",
  model: "a-very-long-model-name-for-responsive-layout-regressions", delivery: "push", startedAt: new Date(),
  folderLabel: "mobile-project", progress: "Reviewing responsive layouts",
} });
let firstRunId = "";
for (let index = 0; index < 14; index++) {
  const run = await h.prisma.run.create({ data: {
    userId: user.id, taskId: task.id, worker: "workspace", requestedModel: job.model,
    outcome: index ? "success" : null, endedAt: index ? new Date() : null,
    result: `## Result\n\n${"LongResult".repeat(30)}\n\n\`\`\`sh\n${"echo output; ".repeat(40)}\n\`\`\``,
    steps: { create: { index: 0, title: "Inspect responsive layout", status: "done", output: "Read the files", toolCalls: [] } },
  } });
  if (index === 0) {
    firstRunId = run.id;
    await h.prisma.workspaceJob.update({ where: { id: job.id }, data: { runId: run.id } });
  } else {
    await h.prisma.workspaceJob.create({ data: {
      userId: user.id, taskId: task.id, runId: run.id, deviceId: device.id, kind: "code",
      status: index % 2 ? "succeeded" : "failed", executionMode: "sandbox", model: job.model,
      delivery: "push", finishedAt: new Date(), summary: "Completed the requested changes.",
    } });
  }
}
await h.prisma.agentDecision.create({ data: {
  userId: user.id, source: "ensemble", event: "question", toolName: "ask",
  title: "Which source scope should I use for the requested documentation and implementation work?",
  detail: { jobId: job.id, deviceId: device.id, deviceName: device.name, taskId: task.id, options: [
    "Read only the requested documentation directories, and preserve every existing permission boundary.",
    `Use the current workspace and report ${"an-unbroken-option-".repeat(12)}`,
  ], recommended: "Read only the requested documentation directories, and preserve every existing permission boundary.", allowCustom: true },
  expiresAt: new Date(Date.now() + 86_400_000),
} });
for (let index = 1; index <= 24; index++) {
  await h.prisma.nodeMessage.create({ data: {
    roomId: room.id, userId: user.id, seq: index, authorKind: index % 2 ? "human" : "node",
    authorNodeId: index % 2 ? null : node.id, kind: index === 24 ? "run" : "text",
    body: index === 24 ? task.title : `Message ${index}: ${"a-long-word-without-breaks".repeat(8)}\n\n\`\`\`sh\n${"echo long-output; ".repeat(30)}\n\`\`\``,
    data: index === 24 ? { jobId: job.id, taskId: task.id, status: "running", computer: device.name } : {},
  } });
}
await h.prisma.nodeRoom.update({ where: { id: room.id }, data: { lastSeq: 24, lastMessageAt: new Date() } });
await h.app.listen({ host: "127.0.0.1", port });
writeFileSync(process.env.MOBILE_FIXTURE_PATH ?? "/tmp/ensemble-mobile-ui.json", JSON.stringify({
  cookie: user.cookie, roomId: room.id, nodeId: node.id, deviceId: device.id, jobId: job.id, taskId: task.id, runId: firstRunId,
}));
console.log(`Isolated mobile UI fixture ready on ${port}.`);
const stop = async () => { await h.close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
