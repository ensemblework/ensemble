import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const root = await mkdtemp(join(homedir(), ".ensemble-file-watch-test-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = join(root, "state");
process.env.DATABASE_URL ??= "postgresql://localhost:1/unused";
const { trackFileChanges } = await import("./file-changes.js");
const { changedFileIdentity, flushFileChanges, originalFile } = await import("../remote/node-files.js");
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

test("direct tools and agent-run reports identify the same original, not another checkout or a linked secret", async () => {
  const first = join(root, "first"), second = join(root, "second");
  await mkdir(first); await mkdir(second);
  await writeFile(join(first, "main.ts"), "const n = 1;");
  await writeFile(join(second, "main.ts"), "const n = 2;");
  const direct = originalFile({ path: first, label: "first" }, "main.ts");
  const agent = await changedFileIdentity(first, ["main.ts"], "main.ts");
  assert.equal(agent?.fileId, direct.fileId);
  assert.ok(agent?.modifiedAt);
  assert.notEqual((await changedFileIdentity(second, ["main.ts"], "main.ts"))?.fileId, agent.fileId);
  await writeFile(join(first, ".env"), "SECRET=not-exposed");
  await symlink(join(first, ".env"), join(first, "linked.ts"));
  assert.equal(await changedFileIdentity(first, ["linked.ts"], "linked.ts"), null);
  await link(join(first, "main.ts"), join(first, "hard.ts"));
  assert.equal(await changedFileIdentity(first, ["hard.ts"], "hard.ts"), null);
});
