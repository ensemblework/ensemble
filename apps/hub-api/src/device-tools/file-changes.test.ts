import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const root = await mkdtemp(join(homedir(), ".ensemble-file-watch-test-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = join(root, "state");
process.env.DATABASE_URL ??= "postgresql://localhost:1/unused";
const { trackFileChanges } = await import("./file-changes.js");
const { flushFileChanges } = await import("../remote/node-files.js");
type Report = Parameters<NonNullable<import("../remote/client.js").HostedClient["reportFileChanges"]>>[0];
after(() => rm(root, { recursive: true, force: true }));

test("short commands in non-Git folders report actual writes, not dependencies or secrets, and retry offline metadata", async () => {
  const folder = join(root, "project");
  await mkdir(join(folder, "src"), { recursive: true });
  await mkdir(join(folder, "node_modules"), { recursive: true });
  const reports: Report[] = [], warnings: unknown[] = [];
  let offline = true;
  const client = { reportFileChanges: async (report: Report) => { if (offline) throw new Error("offline"); reports.push(report); } };
  const stop = await trackFileChanges(client, { nodeId: randomUUID(), operationId: `${randomUUID()}:${randomUUID()}` }, { path: folder, label: "project" }, error => warnings.push(error));
  await writeFile(join(folder, "src", "answer.ts"), "export const answer = 42;\n");
  await writeFile(join(folder, ".env"), "SECRET=never-report\n");
  await writeFile(join(folder, "node_modules", "ignored.js"), "not a source change");
  await stop();
  assert.ok(warnings.length, "offline reporting is explicit");
  assert.equal(reports.length, 0);
  offline = false;
  await flushFileChanges(client);
  assert.deepEqual(reports.flatMap(report => report.files.map(file => file.path)), ["src/answer.ts"]);
  assert.doesNotMatch(JSON.stringify(reports), /export const|SECRET|ignored/);
});
