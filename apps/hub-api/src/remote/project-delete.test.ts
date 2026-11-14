/**
 * A deleted Ensemble project on a computer (remote/project-delete.ts): the Codex projects carrying its id
 * leave the ChatGPT app's sidebar and Codex; the person's own project for the same folder, and another
 * project's, stay. The web's request is answered with what happened.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CodexProjectRow } from "../workspace/engines/app-sessions.js";
import { answerProjectDelete, removeProjectHere } from "./project-delete.js";

const PROJECT = "6f1c2b8e-5d4a-4e3b-9c2d-1a0b9c8d7e6f";
const OURS = "01a1d4f6-4d1b-7e23-a424-e19b82364611";
const OTHER = "01a1d4f6-4d1b-7e23-a424-e19b82364612";
const THEIRS = "01a1cafe-17e6-79d1-896b-d54f71063efb";

test("only the Codex projects carrying the deleted project's id go, from the sidebar and from Codex", async () => {
  const home = mkdtempSync(join(tmpdir(), "project-delete-"));
  try {
    const file = join(home, ".codex", ".codex-global-state.json");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const shown = (id: string, name: string) => ({ id, name, rootPaths: ["/w/projects/launch"], createdAt: 1, updatedAt: 1 });
    writeFileSync(file, JSON.stringify({
      "local-projects": { [OURS]: shown(OURS, "Launch"), [OTHER]: shown(OTHER, "Another project"), "their-local": shown("their-local", "Mine") },
      "project-order": ["their-local", OURS, OTHER],
      "thread-project-assignments": { "t-1": { projectKind: "local", projectId: OURS }, "t-2": { projectKind: "local", projectId: OTHER } },
    }));
    const deleted: string[] = [];
    const projects = async (): Promise<CodexProjectRow[]> => [
      { id: OURS, name: "Launch", roots: [{ path: "/w/projects/launch" }], metadata: { ensembleProjectId: PROJECT } },
      { id: THEIRS, name: "Mine", roots: [{ path: "/w/projects/launch" }], metadata: {} },
      { id: OTHER, name: "Another project", roots: [{ path: "/w/projects/another" }], metadata: { ensembleProjectId: "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d" } },
    ];
    const options = { home, platform: "darwin" as const, env: {}, state: join(home, "state", "codex-app-projects.json"), appOpen: async () => false, retryMs: null, projects, deleteProjects: async (ids: string[]) => void deleted.push(...ids) };
    assert.deepEqual(await removeProjectHere(PROJECT, options), { found: 1, owed: false });
    assert.deepEqual(deleted, [OURS]);
    const state = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(state["local-projects"] as object).sort(), [OTHER, "their-local"]);
    assert.deepEqual(state["project-order"], ["their-local", OTHER]);
    assert.deepEqual(state["thread-project-assignments"], { "t-2": { projectKind: "local", projectId: OTHER } });
    assert.deepEqual(state["projectless-thread-ids"], ["t-1"]);

    // A computer where Ensemble never made one for it: nothing to do.
    assert.deepEqual(await removeProjectHere("1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e", options), { found: 0, owed: false });
    assert.deepEqual(deleted, [OURS]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the web's request is answered with what happened, and a bad one is refused", async () => {
  const answers: Array<{ id: string; answer: unknown }> = [];
  const client = { answerCode: async (id: string, answer: unknown) => void answers.push({ id, answer }) };
  await answerProjectDelete(client as never, { id: "req-1", projectId: PROJECT }, async (projectId) => ({ found: projectId === PROJECT ? 1 : 0, owed: true }));
  await answerProjectDelete(client as never, { id: "req-2", projectId: "../../etc" });
  await answerProjectDelete(client as never, { id: "req-3", projectId: PROJECT }, async () => Promise.reject(new Error("The agent did not confirm deletion in time.")));
  await answerProjectDelete(client as never, { projectId: PROJECT });
  assert.deepEqual(answers, [
    { id: "req-1", answer: { status: 200, body: { deleted: true, found: 1, owed: true } } },
    { id: "req-2", answer: { status: 409, body: { error: "Invalid project deletion request." } } },
    { id: "req-3", answer: { status: 409, body: { error: "The agent did not confirm deletion in time." } } },
  ]);
});
