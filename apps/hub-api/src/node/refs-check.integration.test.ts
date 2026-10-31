/**
 * `validateRefs` (node/refs-check.ts): every `ensemble://<kind>/<id>` link in a node's reply must name a
 * record its owner can open. Real records of each kind pass, in the owner's own space and in a space
 * shared with them; a made-up id, another account's record, one in Trash, a kind no reply renders and an
 * evidence id written as a file are each listed with why, once, in the order written.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { createHttpHarness } from "../test/http.js";

const h = await createHttpHarness();
const { validateRefs } = await import("./refs-check.js");
const { saveFile } = await import("../files/store.js");
after(() => h.close());

test("links to the owner's records pass; made-up, foreign, trashed, unknown and evidence links are listed with why", async () => {
  const mira = await h.asUser();
  const ada = await h.asUser();
  const db = h.prisma;
  const file = await saveFile(db, mira.id, { filename: "paper.pdf", mediaType: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4 paper") }, { summarize: false });
  const trashed = await saveFile(db, mira.id, { filename: "old.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("old") }, { summarize: false });
  await db.document.update({ where: { id: trashed.id }, data: { deletedAt: new Date() } });
  const task = await db.task.create({ data: { userId: mira.id, title: "Ship the release" } });
  const page = await db.taskPage.create({ data: { userId: mira.id, title: "Notes" } });
  const project = await db.project.create({ data: { userId: mira.id, name: "Launch" } });
  const plot = await db.plot.create({ data: { userId: mira.id, title: "Prices" } });
  const diagram = await db.blockDiagram.create({ data: { userId: mira.id, title: "Pipeline" } });
  const dataset = await db.plotDataset.create({ data: { userId: mira.id, name: "prices.csv", format: "csv", columns: [], rowCount: 0, byteSize: 0, contentHash: "x" } });
  const created = await mira.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } });
  const room = (created.json() as { room: { id: string } }).room;
  const foreign = await db.task.create({ data: { userId: ada.id, title: "Ada's task" } });
  const evidence = randomUUID();
  await db.jobEvidence.create({ data: { id: evidence, userId: mira.id, operation: "node:x:own", kind: "report", name: "paper.pdf", mime: "application/pdf", size: 3, sha256: "c".repeat(64), storageKey: evidence, bytes: new Uint8Array([1, 2, 3]) } });
  // A space shared with Mira: its records are hers to open too.
  const shared = await db.user.create({ data: { email: `space-${randomUUID()}@example.test`, name: "Team", ownerId: ada.id, spaceName: "Team" } });
  await db.spaceMember.create({ data: { spaceId: shared.id, accountId: mira.id, role: "editor", addedBy: ada.id } });
  const teamTask = await db.task.create({ data: { userId: shared.id, title: "Team task" } });

  const good = [
    `[paper.pdf](ensemble://file/${file.id})`,
    `[Ship the release](ensemble://task/${task.id})`,
    `see ensemble://page/${page.id}.`,
    `[Launch](ensemble://project/${project.id})`,
    `[Prices](ensemble://plot/${plot.id})`,
    `[A tile](ensemble://plot/${plot.id}/tile-1)`,
    `[Pipeline](ensemble://diagram/${diagram.id})`,
    `[prices.csv](ensemble://dataset/${dataset.id})`,
    `[DM](ensemble://room/${room.id})`,
    `[Team task](ensemble://tasks/${teamTask.id})`,
  ].join("\n");
  assert.deepEqual(await validateRefs(good, mira.id, db), []);

  const missing = randomUUID();
  const bad = [
    `Here it is: [paper.pdf](ensemble://file/${evidence})`,
    `[Ghost](ensemble://task/${missing}) and again ensemble://task/${missing}`,
    `[Ada's](ensemble://task/${foreign.id})`,
    `[Old](ensemble://file/${trashed.id})`,
    `[Odd](ensemble://evidence/${evidence})`,
    `[Nope](ensemble://project/not-an-id)`,
    `[Good](ensemble://project/${project.id})`,
  ].join("\n");
  const problems = await validateRefs(bad, mira.id, db);
  assert.deepEqual(
    problems.map((row) => [row.kind, row.id]),
    [
      ["file", evidence],
      ["task", missing],
      ["task", foreign.id],
      ["file", trashed.id],
      ["evidence", evidence],
      ["project", "not-an-id"],
    ],
    "each broken link once, in the order written",
  );
  assert.equal(problems[0]!.href, `ensemble://file/${evidence}`);
  assert.match(problems[0]!.problem, /That is evidence \(a capture or download\), not a file in Ensemble Files\. Save it with hub_save_file \{evidence\}/);
  assert.match(problems[1]!.problem, /There is no task with this id that your owner can open/);
  assert.match(problems[3]!.problem, /no file in Ensemble Files with this id/);
  assert.match(problems[4]!.problem, /not a kind of link Ensemble opens/);
  assert.match(problems[5]!.problem, /“not-an-id” is not an id of a project/);
  assert.deepEqual(await validateRefs("No links here.", mira.id, db), []);
  assert.equal((await validateRefs(`[Ship](ensemble://task/${task.id})`, ada.id, db)).length, 1, "the same link is broken for someone else");
});
