import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acpTurns } from "../subscriptions/outside.js";
import { claudeProjectName } from "../subscriptions/session-touch.js";
import { deleteNativeSession } from "./engines/delete-session.js";
import { noteSessionPrompts, outsideNote, outsideStep, projectSessions, projectSessionsNote, replayOutside, runOutside } from "./outside-runs.js";

const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const said = (text: string, entrypoint = "claude-desktop-3p") => ({ type: "user", entrypoint, timestamp: "2026-11-15T07:05:00.000Z", message: { role: "user", content: text } });
const answered = (text: string, tools: unknown[] = []) => ({ type: "assistant", message: { role: "assistant", content: [...tools, { type: "text", text }] } });

/** A fake of the events a computer keeps: its runs' `engine` events and their `session_prompts`. */
function events(rows: Array<{ kind: string; data: Record<string, unknown> }>) {
  return {
    workspaceEvent: {
      findFirst: async ({ where }: { where: { kind: string; data: { path: string[]; equals: string } } }) => [...rows].reverse().find((row) => row.kind === where.kind && row.data[where.data.path[0]!] === where.data.equals) ?? null,
      findMany: async ({ where }: { where: { kind: string } }) => rows.filter((row) => row.kind === where.kind),
    },
  } as never;
}

test("a run that continues a Claude Code session brings in what the person said there since Ensemble's last run, as a step and a note", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-outside-run-"));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    const id = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
    const folder = "/Users/me/ensemble-workspace/projects/launch";
    mkdirSync(join(root, "projects", claudeProjectName(folder)), { recursive: true });
    writeFileSync(join(root, "projects", claudeProjectName(folder), `${id}.jsonl`), jsonl([said("Write the plan.", "sdk-cli"), answered("Wrote it."), said("Also remember MANGO"), answered("Noted MANGO.", [{ type: "tool_use", name: "Edit", input: { file_path: `${folder}/plan.md` } }])]));
    assert.equal(await runOutside(events([]), "claude-code", id, folder), null, "no run noted the session's prompts yet");
    const outside = await runOutside(events([{ kind: "session_prompts", data: { session: id, prompts: 1 } }]), "claude-code", id, folder);
    assert.deepEqual(outside, { app: "the Claude app", turns: [{ prompt: "Also remember MANGO", answer: "Noted MANGO.", tools: "Edited 1 file", files: [`${folder}/plan.md`], at: "2026-11-15T07:05:00.000Z" }], earlier: 0 });
    assert.equal(await runOutside(events([{ kind: "session_prompts", data: { session: id, prompts: 2 } }]), "claude-code", id, folder), null, "nothing since");
    assert.equal(await runOutside(events([{ kind: "session_prompts", data: { session: id, prompts: 1 } }]), "cursor-agent", id, folder), null, "an agent whose history is not read here");

    assert.equal(outsideStep(outside!, "Akash"), "Akash: Also remember MANGO\nAgent: Noted MANGO. (Edited 1 file)");
    assert.equal(outsideNote(outside!, "Akash"), '(Since the last Ensemble run, Akash said in the Claude app:\n- "Also remember MANGO" (you edited 1 file)\nThat is part of this conversation already: take it into account.)');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor's agent and the ACP agents: what the person said comes from the session's replay, after the prompts the last run noted, and the engine's own count is noted", async () => {
  const update = (value: Record<string, unknown>) => ({ sessionId: "ses_1", update: value });
  const history = acpTurns([
    update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Write the plan." } }),
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Wrote it." } }),
    update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Also remember MANGO" } }),
    update({ sessionUpdate: "tool_call", kind: "edit", locations: [{ path: "/w/plan.md" }] }),
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Noted MANGO." } }),
  ]);
  const noted = (prompts: number) => events([{ kind: "session_prompts", data: { session: "ses_1", prompts } }]);
  assert.equal(await replayOutside(events([]), "opencode", "ses_1", history), null, "no run noted the session's prompts yet");
  assert.deepEqual(await replayOutside(noted(1), "opencode", "ses_1", history), { app: "OpenCode", turns: [{ prompt: "Also remember MANGO", answer: "Noted MANGO.", tools: "Edited 1 file", files: ["/w/plan.md"] }], earlier: 0 });
  assert.equal((await replayOutside(noted(1), "cursor-agent", "ses_1", history))?.app, "Cursor");
  assert.equal(await replayOutside(noted(2), "opencode", "ses_1", history), null, "nothing since");
  assert.equal(await runOutside(noted(1), "opencode", "ses_1", "/w"), null, "not read before the run: the engine hands the replay over");

  const marks: unknown[] = [];
  const ctx = { event: async (kind: string, data: Record<string, unknown>) => void marks.push([kind, data]) };
  await noteSessionPrompts(ctx, "opencode", "ses_1", "/w", 3);
  await noteSessionPrompts(ctx, "opencode", "ses_1", "/w", null);
  assert.deepEqual(marks, [["session_prompts", { session: "ses_1", prompts: 3 }]], "the engine's count; none when it could not count");
});

test("a new task in a project lists the sessions the person started there since its last run, never Ensemble's, and its clean-up leaves them", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-own-sessions-"));
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, COPILOT_HOME: process.env.COPILOT_HOME, ENSEMBLE_REMOTE_STATE_DIR: process.env.ENSEMBLE_REMOTE_STATE_DIR };
  // A home of its own: deleting a Claude Code session also looks in the Claude app's profiles there.
  process.env.HOME = root;
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  process.env.COPILOT_HOME = join(root, "copilot");
  process.env.ENSEMBLE_REMOTE_STATE_DIR = join(root, "state");
  try {
    const folder = join(root, "projects", "launch");
    const sessions = join(root, "claude", "projects", claudeProjectName(folder));
    mkdirSync(sessions, { recursive: true });
    const ours = "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a";
    const theirs = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b";
    writeFileSync(join(sessions, `${ours}.jsonl`), jsonl([said("Ensemble's task", "sdk-cli"), answered("Done.")]));
    writeFileSync(join(sessions, `${theirs}.jsonl`), jsonl([said("Try a darker theme"), answered("Done.", [{ type: "tool_use", name: "Edit", input: { file_path: `${folder}/theme.css` } }]), said("Now the header")]));
    const copilot = join(root, "copilot", "session-state", "6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c");
    mkdirSync(copilot, { recursive: true });
    writeFileSync(join(copilot, "events.jsonl"), jsonl([{ type: "session.start", data: { context: { cwd: folder } } }, { type: "user.message", data: { content: "Fix the footer" } }, { type: "assistant.message", data: { content: "Fixed." } }]));
    const elsewhere = join(root, "copilot", "session-state", "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "events.jsonl"), jsonl([{ type: "session.start", data: { context: { cwd: "/somewhere/else" } } }, { type: "user.message", data: { content: "Other work" } }]));

    const prisma = events([{ kind: "engine", data: { session: ours } }]);
    const listed = await projectSessions(prisma, { id: "project-1", folder }, new Date(Date.now() - 60_000), { codex: false });
    assert.deepEqual(
      listed.map((one) => [one.app, one.title, one.last, one.files]).sort(),
      [
        ["GitHub Copilot", "Fix the footer", "Fix the footer", []],
        ["the Claude app", "Try a darker theme", "Now the header", [`${folder}/theme.css`]],
      ],
    );
    assert.deepEqual(listed.map((one) => one.title).sort(), ["Fix the footer", "Try a darker theme"], "the person's two; Ensemble's own and another folder's are not listed");
    assert.deepEqual(await projectSessions(prisma, { id: "project-1", folder }, new Date(Date.now() + 60_000), { codex: false }), [], "nothing since a later run");
    const note = projectSessionsNote(listed, "Akash");
    assert.match(note, /Sessions Akash started in this project outside Ensemble/);
    assert.match(note, /In the Claude app: "Try a darker theme"; last message: "Now the header"; files changed: .*theme\.css/);
    assert.match(note, /do not continue, rename or delete them/);
    assert.equal(projectSessionsNote([], "Akash"), "");

    // Cleaning up Ensemble's own session in the project removes only that one.
    await deleteNativeSession("claude-code", ours, folder);
    assert.equal(existsSync(join(sessions, `${ours}.jsonl`)), false);
    assert.equal(existsSync(join(sessions, `${theirs}.jsonl`)), true, "the person's own session stays");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
