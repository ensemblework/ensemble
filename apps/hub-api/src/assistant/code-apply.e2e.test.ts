/**
 * Ensemble Code on a desktop runtime: Applying ensemble_start_agent (what the CLI's Apply button
 * sends) creates the task and starts a run in the launch folder, under the run profile.
 */
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { bootSidecar, prepareAccount, startStubRuntime } from "../desktop/e2e-harness.js";
import { makeTestDirectory } from "../test/temporary.js";

test("Applying ensemble_start_agent starts a run in the launch folder under the run profile", { timeout: 300_000 }, async () => {
  const root = makeTestDirectory("ensemble-code-apply-");
  const project = join(root, "project");
  mkdirSync(project);
  const runtime = await startStubRuntime();
  const side = await bootSidecar(root, runtime.url);
  try {
    await prepareAccount(side);
    const saved = await side.api("/api/settings", {
      method: "PATCH",
      json: { runProfiles: [{ id: "careful", name: "Careful", kind: "code", engine: "ensemble", mode: "ask", delivery: "local", sandbox: false, network: false }], defaultRunProfileId: "careful" },
    });
    assert.equal(saved.status, 200, `${JSON.stringify(saved.body)}\n${side.logs().slice(-3000)}`);
    const applied = await side.api<{ summary?: string; error?: string }>("/api/assistant/apply", {
      json: { calls: [{ name: "ensemble_start_agent", input: { title: "Tidy the README", instructions: "Fix the typos." } }], code: { folder: project } },
    });
    assert.equal(applied.status, 200, `${JSON.stringify(applied.body)}\n${side.logs().slice(-4000)}`);
    assert.match(applied.body.summary ?? "", /Started Ensemble's agent on “Tidy the README”/);
    const board = await side.api<{ queued: Array<{ title: string; folder: string; delivery: string; executionMode: string; networkAccess: boolean; instructions: string }>; running: unknown[]; stopped: unknown[]; completed: unknown[]; waiting: unknown[] }>("/api/workspace");
    const all = [...board.body.queued, ...(board.body.running as never[]), ...(board.body.stopped as never[]), ...(board.body.completed as never[]), ...(board.body.waiting as never[])] as Array<{ title: string; folder: string; delivery: string; executionMode: string; networkAccess: boolean; instructions: string }>;
    const run = all.find((row) => row.title === "Tidy the README");
    assert.ok(run, JSON.stringify(board.body));
    assert.equal(run.folder, realpathSync(project));
    assert.equal(run.delivery, "local", "the profile's git permission");
    assert.equal(run.executionMode, "native", "the profile's sandbox setting");
    assert.equal(run.networkAccess, false);
    assert.match(run.instructions, /Fix the typos\./);
    // Not a folder Ensemble may use: the reason comes back, nothing starts.
    const refused = await side.api<{ error?: string }>("/api/assistant/apply", {
      json: { calls: [{ name: "ensemble_start_agent", input: { title: "Nope", folder: "/" } }], code: { folder: project } },
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error ?? "", /Ask the person for a project folder/);
  } finally {
    await side.stop();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
