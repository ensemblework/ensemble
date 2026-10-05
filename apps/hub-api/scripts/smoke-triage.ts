/**
 * Runs fetch triage against two sample emails with the real model on the low tier:
 * one real ask, one newsletter. Cleans up after itself.
 *
 *   pnpm --filter @ensemble/hub-api exec tsx scripts/smoke-triage.ts
 */
import { upsertArtifact } from "../src/connectors/ingest.js";
import { triage } from "../src/connectors/triage.js";
import { env } from "../src/config.js";
import { prisma } from "../src/lib/prisma.js";
import { loadSettings } from "../src/lib/settings.js";

const userId = env.ENSEMBLE_DEV_USER_ID;

async function main(): Promise<void> {
  const settings = await loadSettings(prisma, userId);
  const ask = await upsertArtifact(userId, {
    kind: "email",
    externalId: "smoke-ask",
    threadId: "smoke-thread-ask",
    ts: new Date(),
    title: "Load test numbers before Thursday?",
    text: "Hi, could you send me the p95 numbers from the load test before Thursday's review? I need them for the deck. Thanks, Rahul",
    participants: [{ name: "Rahul Mehta", email: "rahul.mehta@example.com" }],
    metadata: { from: "Rahul Mehta <rahul.mehta@example.com>", directlyToMe: true },
  });
  const newsletter = await upsertArtifact(userId, {
    kind: "email",
    externalId: "smoke-news",
    threadId: "smoke-thread-news",
    ts: new Date(),
    title: "This week in TypeScript",
    text: "Five new features in TypeScript 6. Read more on our blog. Unsubscribe any time.",
    participants: [{ name: "TS Weekly", email: "news@tsweekly.example" }],
    metadata: { from: "TS Weekly <news@tsweekly.example>", directlyToMe: false },
  });
  const started = Date.now();
  const result = await triage(userId, { ...settings, fetch: { ...settings.fetch, proposeTodos: true } }, [ask, newsletter]);
  const tasks = await prisma.task.findMany({ where: { userId, sourceRef: { startsWith: "gmail:thread:smoke-thread" } } });
  const extractions = await prisma.extraction.findMany({ where: { artifactId: { in: [ask.id, newsletter.id] } } });
  console.log(JSON.stringify({ ms: Date.now() - started, ...result, model: extractions[0]?.model, tasks: tasks.map((task) => ({ title: task.title, priority: task.priority, due: task.due, excerpt: task.excerpt })) }, null, 2));
  await prisma.task.deleteMany({ where: { id: { in: tasks.map((task) => task.id) } } });
  await prisma.artifact.deleteMany({ where: { id: { in: [ask.id, newsletter.id] } } });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
