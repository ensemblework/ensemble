/** Which of a node's own sessions new work fits (node/session-fit.ts): related work fits, unrelated does not. */
import assert from "node:assert/strict";
import test from "node:test";
import type { NodeSession } from "./sessions.js";

const { fitMessage, fitSessions } = await import("./session-fit.js");

const now = new Date("2026-11-10T10:00:00Z");
const session = (id: string, minutesAgo: number, tasks = 2) =>
  ({ id, agentName: "GitHub Copilot", folder: "ensemble", computer: "HomeServer", tasks, lastActiveAt: new Date(now.getTime() - minutesAgo * 60_000).toISOString() }) as unknown as NodeSession;
// The owner's other tasks: the common words in them ("fix", "update", "page") weigh nothing.
const prisma = {
  task: {
    findMany: async () =>
      Array.from({ length: 60 }, (_, index) => ({ title: ["Fix the page footer", "Update the README", "Fix the CI badge", "Update the landing page copy"][index % 4]!, description: "" })),
  },
} as never;

const candidates = [
  {
    session: session("11111111-1111-1111-1111-111111111111", 30),
    work: [
      { title: "Rate limiter for the public API", asked: "Add a token-bucket rate limiter to apps/hub-api/src/lib/rate-limit.ts and tests", result: "Added the rate limiter in src/lib/rate-limit.ts with tests; all pass." },
      { title: "Rate limit headers", asked: "Return Retry-After from the rate limiter", result: "Retry-After added." },
    ],
  },
  {
    session: session("22222222-2222-2222-2222-222222222222", 600),
    work: [{ title: "Dark mode for the dock", asked: "Make the assistant dock follow dark mode", result: "Dock follows the theme." }],
  },
];

test("a follow-up on the rate limiter fits that session, with why; unrelated work fits none", async () => {
  const fits = await fitSessions(prisma, "u1", { title: "Fix the rate limiter's burst handling", prompt: "The rate limiter in src/lib/rate-limit.ts lets bursts through. Fix it and add a test." }, candidates, now);
  assert.equal(fits[0]?.id, "11111111-1111-1111-1111-111111111111");
  assert.match(fits[0]!.why, /rate-limit\.ts|rate limit/);
  assert.ok(!fits.some((fit) => fit.id.startsWith("2222")), "the dark-mode session does not fit");
  const message = fitMessage(fits);
  assert.match(message, /^Not started yet/);
  assert.match(message, /node_session_send/);
  assert.match(message, /newSession: true/);
  assert.deepEqual(await fitSessions(prisma, "u1", { title: "Write a Kubernetes deployment for the worker", prompt: "Helm chart for the background worker with autoscaling." }, candidates, now), []);
});

test("a session too long in use is not offered", async () => {
  const full = [{ ...candidates[0]!, session: session("33333333-3333-3333-3333-333333333333", 30, 40) }];
  assert.deepEqual(await fitSessions(prisma, "u1", { title: "Fix the rate limiter's burst handling", prompt: "src/lib/rate-limit.ts lets bursts through." }, full, now), []);
});
