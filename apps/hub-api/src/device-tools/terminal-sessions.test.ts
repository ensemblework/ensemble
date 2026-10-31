/**
 * A node's live terminals on this computer (device-tools/terminal-sessions.ts) and their live view
 * (takeover/terminal-view.ts): a shell in a pseudo-terminal in the sandbox kept between calls, its
 * screen as text and as runs of cells with secrets hidden, each line the node submits judged (the
 * dangerous ones refused and cleared, also when recalled or typed by the owner first), the owner's
 * typing and resizing, the end of a session by close, exit or idle, at most three per node, and frames
 * only the owner's browser opens, sent on change at most 15 a second, with control making the node wait.
 * The runs skip where this computer has no OS sandbox or no `script`.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const base = mkdtempSync(join(homedir(), ".ensemble-live-terminal-"));
process.env.DATABASE_URL ??= "postgresql://localhost/unused";
process.env.ENSEMBLE_REMOTE_STATE_DIR = join(base, "data");
process.env.ENSEMBLE_WORKSPACE_ROOT = join(base, "ensemble-workspace");
process.env.ENSEMBLE_SECRET_KEY ??= randomBytes(32).toString("base64");

const { runNodeLive, closeAllSessions, terminalSession, ownerType, ownerKey, resizeSession, setLiveTimingForTests, judgeLine, promptEnv } = await import("./terminal-sessions.js");
const { ownToolFolder } = await import("./folders.js");
const { headlessTerminal, drawn, screenRows } = await import("../capture/screen.js");
const { startTerminalView, terminalViewInput, controlTerminalView, endTerminalView, terminalViewStats } = await import("../takeover/terminal-view.js");
const { takeoverKeys, sealMessage, openMessage, unpackMessage } = await import("../takeover/channel.js");
const { prepareSandbox } = await import("../workspace/sandbox/spawn.js");
const { findOnPath } = await import("../capture/system.js");
const { LiveAnswer } = await import("../remote/contract.js");

after(async () => {
  await closeAllSessions("stopped").catch(() => undefined);
  setLiveTimingForTests(null);
  rmSync(base, { recursive: true, force: true });
});

test("a screen as runs: colours as #rrggbb, bold, italic, underline, dim, trailing blanks left out; a secret hidden and drawn plain", async () => {
  const term = await headlessTerminal(40, 5);
  term.write("\u001b[31mRED\u001b[0m \u001b[1;32mBOLD\u001b[0m \u001b[3mIT\u001b[0m \u001b[4mU\u001b[0m \u001b[2mD\u001b[0m \u001b[44mBG\u001b[0m   \r\n");
  term.write("plain\r\n");
  term.write("key \u001b[33msk-live-abcdefghijklmnopqrstuvwxyz\u001b[0m and hunter2-hunter2\r\n");
  await drawn(term);
  const { rows, text, hidden } = screenRows(term, { secretValues: ["hunter2-hunter2"] });
  term.dispose();
  assert.equal(rows.length, 5, "every row, the empty ones too");
  assert.deepEqual(rows[0], [
    { t: "RED", fg: "#cd3131" },
    { t: " " },
    { t: "BOLD", fg: "#23d18b", b: 1 },
    { t: " " },
    { t: "IT", i: 1 },
    { t: " " },
    { t: "U", u: 1 },
    { t: " " },
    { t: "D", dim: 1 },
    { t: " " },
    { t: "BG", bg: "#2472c8" },
  ]);
  assert.deepEqual(rows[1], [{ t: "plain" }]);
  assert.equal(hidden, true);
  assert.equal(rows[2]!.length, 1, "a line with a secret is drawn plain");
  assert.doesNotMatch(JSON.stringify(rows), /sk-live|abcdefgh|hunter2/);
  assert.match(rows[2]![0]!.t, /^key \[redacted\] and \[hidden\]$/);
  assert.deepEqual(rows[3], []);
  assert.doesNotMatch(text, /sk-live|hunter2/);
});

test("lines are judged as the shell runs them: the hard floor always, at the prompt also programs no agent runs", () => {
  const cwd = homedir();
  assert.match(judgeLine("rm -rf ~", { shell: true, network: true, cwd }) ?? "", /home folder|whole disk|Recursive/i);
  assert.match(judgeLine("reboot", { shell: false, network: true, cwd }) ?? "", /.+/, "the floor also while a program reads the line");
  assert.match(judgeLine("ls && sudo apt update", { shell: true, network: true, cwd }) ?? "", /sudo/);
  assert.match(judgeLine("curl https://example.com", { shell: true, network: false, cwd }) ?? "", /network/);
  assert.equal(judgeLine("./configure --prefix=$HOME/.local && make", { shell: true, network: true, cwd }), null, "scripts by path run in the sandbox as bash -c would");
  assert.equal(judgeLine("print('sudo')", { shell: false, network: true, cwd }), null, "a program's input is not read as a shell line");
  assert.equal(judgeLine("", { shell: true, network: true, cwd }), null);
  assert.match(promptEnv("my-node", true).PS1!, /133;A.*my-node.*133;B/);
  assert.match(promptEnv("my-node", true).PS0!, /133;C/);
});

const caps = await prepareSandbox();
const skipRun = !caps.osSandbox ? `no OS sandbox here: ${caps.reason}` : process.platform === "win32" || !findOnPath("script") ? "no `script` here" : false;

const nodeId = "5c0ffee0-0000-4000-8000-00000000live";
const operation = `node:${nodeId}:own`;
const call = (over: Record<string, unknown>) => ({ id: randomUUID(), tool: "live", columns: 80, rows: 16, keys: [], operation, network: false, nodeId, nodeSlug: "tester", mission: "m", attended: false, grants: [], ...over });
const db = { runSecret: { findMany: async () => [] } };

function fakeClient() {
  const ended: Array<{ liveId: string; reason: string; exitCode?: number | null }> = [];
  const frames: Array<{ id: string; message: { seq: number; iv: string; ct: string } }> = [];
  const states: Array<{ id: string; reason: string }> = [];
  return {
    ended,
    frames,
    states,
    client: {
      liveEnded: async (liveId: string, body: { reason: string; exitCode?: number | null }) => void ended.push({ liveId, ...body }),
      takeoverFrame: async (id: string, message: { seq: number; iv: string; ct: string }) => (frames.push({ id, message }), true),
      takeoverState: async (id: string, body: { reason: string }) => void states.push({ id, reason: body.reason }),
    },
  };
}

async function live(client: unknown, over: Record<string, unknown>) {
  const folder = await ownToolFolder({ nodeId, nodeSlug: "tester" });
  const done = await runNodeLive({ prisma: db } as never, client as never, call(over) as never, folder);
  return { status: done.status, body: LiveAnswer.parse(done.body), raw: done.body as Record<string, unknown> };
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("a shell kept open between calls: commands and their output, a program that asks, scrollback, the owner's size; closed, its card is told", { skip: skipRun, timeout: 120_000 }, async () => {
  const fake = fakeClient();
  const opened = await live(fake.client, { action: "terminal_open", title: "Build" });
  assert.equal(opened.status, 200, JSON.stringify(opened.raw));
  const session = opened.body.session!;
  assert.match(session, /^ts[0-9a-f]{12}$/);
  assert.equal(opened.body.title, "Build");
  assert.equal(opened.body.atPrompt, true, "the shell waits at its prompt");
  assert.match(opened.body.screen!, /tester/, "the prompt names the node");

  const echoed = await live(fake.client, { action: "terminal_send", session, text: "export GREETING=hello; echo \"$GREETING from $(basename $PWD)\"", keys: ["Enter"] });
  assert.equal(echoed.status, 200, JSON.stringify(echoed.raw));
  assert.match(echoed.body.screen!, /hello from /);
  assert.equal(echoed.body.atPrompt, true);
  // Kept between calls: the variable is still set.
  const kept = await live(fake.client, { action: "terminal_send", session, text: "echo again $GREETING\n" });
  assert.match(kept.body.screen!, /again hello/);

  // A program that asks: the screen while it waits, then the answer.
  const asked = await live(fake.client, { action: "terminal_send", session, text: "read -p 'Name? ' name; echo \"got $name\"\n", waitMs: 800 });
  assert.equal(asked.body.atPrompt, false, "something waits for input");
  assert.match(asked.body.screen!, /Name\? $/m);
  const answered = await live(fake.client, { action: "terminal_send", session, text: "Mira", keys: ["Enter"] });
  assert.match(answered.body.screen!, /got Mira/);

  // More than a screen: the last lines with scrollback.
  await live(fake.client, { action: "terminal_send", session, text: "seq 1 60\n" });
  const lines = await live(fake.client, { action: "terminal_read", session, lines: 70 });
  assert.match(lines.body.screen!, /^1$/m);
  assert.match(lines.body.screen!, /^60$/m);
  assert.doesNotMatch((await live(fake.client, { action: "terminal_read", session })).body.screen!, /^1$/m, "the screen alone shows the end");

  // The owner's screen size reaches the program; the owner's typing goes in as typed.
  const shell = terminalSession(session)!;
  await resizeSession(shell, 100, 20);
  ownerType(shell, "stty size");
  assert.equal(ownerKey(shell, "Enter"), true);
  await until(async () => /^20 100$/m.test((await live(fake.client, { action: "terminal_read", session })).body.screen!), "the new size in the shell");
  assert.equal(ownerKey(shell, "NotAKey"), false);

  const closed = await live(fake.client, { action: "terminal_close", session });
  assert.equal(closed.status, 200);
  assert.deepEqual(fake.ended.map((row) => [row.liveId, row.reason]), [[session, "closed"]]);
  const gone = await live(fake.client, { action: "terminal_read", session });
  assert.deepEqual([gone.status, gone.body.ended, gone.raw.gone], [200, true, true], "a closed terminal says it ended");
});

test("a dangerous line is refused and cleared, typed by the node, recalled from history or typed by the owner first; programs no agent runs too", { skip: skipRun, timeout: 120_000 }, async () => {
  const fake = fakeClient();
  const session = (await live(fake.client, { action: "terminal_open" })).body.session!;
  const refused = await live(fake.client, { action: "terminal_send", session, text: "rm -rf ~", keys: ["Enter"] });
  assert.equal(refused.status, 403);
  assert.match(String(refused.raw.error), /home folder|Recursive/i);
  assert.equal(refused.body.atPrompt, true);
  assert.doesNotMatch(refused.body.screen!.split("\n").at(-1)!, /rm -rf/, "the line was cleared, not run");

  // Typed by the owner, then Enter from the node: the line on the screen is judged.
  ownerType(terminalSession(session)!, "rm -rf $HOME");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await live(fake.client, { action: "terminal_send", session, keys: ["Enter"] })).status, 403);

  // A command from history: the screen shows what Up recalled.
  await live(fake.client, { action: "terminal_send", session, text: ": rm -rf ~ never ran\n" });
  const recalled = await live(fake.client, { action: "terminal_send", session, keys: ["Up", "Ctrl+A", "Delete", "Delete", "Enter"] });
  assert.equal(recalled.status, 403, JSON.stringify(recalled.raw));

  assert.equal((await live(fake.client, { action: "terminal_send", session, text: "sudo true\n" })).status, 403, "sudo is computer_sudo's");
  const fine = await live(fake.client, { action: "terminal_send", session, text: "echo still here\n" });
  assert.equal(fine.status, 200);
  assert.match(fine.body.screen!, /^still here$/m);
  await live(fake.client, { action: "terminal_close", session });
});

test("a session ends when its shell exits or nobody uses it, and a node keeps at most three", { skip: skipRun, timeout: 120_000 }, async () => {
  const fake = fakeClient();
  const first = (await live(fake.client, { action: "terminal_open" })).body.session!;
  await live(fake.client, { action: "terminal_send", session: first, text: "exit 4\n", waitMs: 300 });
  await until(() => fake.ended.some((row) => row.liveId === first), "the exit");
  assert.deepEqual(fake.ended.find((row) => row.liveId === first), { liveId: first, reason: "exited", exitCode: 4 });

  const open = [];
  for (let index = 0; index < 3; index += 1) open.push((await live(fake.client, { action: "terminal_open" })).body.session!);
  const fourth = await live(fake.client, { action: "terminal_open" }).catch((error: unknown) => error);
  assert.equal((fourth as { status: number }).status, 409);
  assert.match(String((fourth as { raw: { error: string } }).raw.error), /3 terminals open/);
  const other = await runNodeLive({ prisma: db } as never, fake.client as never, call({ action: "terminal_read", session: open[0], nodeId: "another-node" }) as never, null);
  assert.equal(other.status, 404, "another node's terminal is not readable");
  for (const id of open) await live(fake.client, { action: "terminal_close", session: id });

  setLiveTimingForTests({ idleMs: 400 });
  const idle = (await live(fake.client, { action: "terminal_open" })).body.session!;
  await until(() => fake.ended.some((row) => row.liveId === idle), "the idle end", 15_000);
  assert.equal(fake.ended.find((row) => row.liveId === idle)!.reason, "idle");
  setLiveTimingForTests(null);
});

test("the owner's live view: frames only their browser opens, on change at most 15 a second; they type while watching; control makes the node wait", { skip: skipRun, timeout: 120_000 }, async () => {
  const fake = fakeClient();
  const session = (await live(fake.client, { action: "terminal_open", title: "Live" })).body.session!;
  const takeoverId = randomUUID();
  const secret = randomBytes(32);
  const keys = takeoverKeys(Buffer.from(secret), takeoverId);
  const frame = { id: "q1", takeoverId, tab: session, sealed: {} as never, endsAt: new Date(Date.now() + 60_000).toISOString(), kind: "terminal" as const, operation, view: "watch" as const };
  const box = () => ({ secret: Buffer.from(secret), nonce: randomBytes(16).toString("hex"), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((await startTerminalView(fake.client as never, { ...frame, operation: "node:someone-else:own" }, box, 60_000)).status, 404, "only the node's own terminal");
  const started = await startTerminalView(fake.client as never, frame, box, 60_000);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.deepEqual([started.body.kind, started.body.view], ["terminal", "watch"]);

  const opened = () =>
    fake.frames.filter((row) => row.id === takeoverId).map((row) => {
      const { header, payload } = unpackMessage(openMessage(keys.d2w, takeoverId, "d2w", row.message));
      return { header, screen: JSON.parse(payload.toString("utf8")) as { rows: Array<Array<{ t: string }>> } };
    });
  const text = (screen: { rows: Array<Array<{ t: string }>> }) => screen.rows.map((row) => row.map((run) => run.t).join("")).join("\n");
  await until(() => opened().length > 0, "the first frame");
  const first = opened()[0]!;
  assert.deepEqual(Object.keys(first.header).sort(), ["cols", "cursor", "kind", "rows", "t", "title"]);
  assert.deepEqual([first.header.t, first.header.kind, first.header.cols, first.header.rows, first.header.title], ["frame", "terminal", 80, 16, "Live"]);
  assert.equal(first.screen.rows.length, 16);
  assert.ok(fake.frames.every((row) => !row.message.ct.includes(Buffer.from("tester").toString("base64url"))), "frames leave encrypted");

  // The owner types while watching: their shell.
  let seq = 0;
  const send = (events: unknown[]) => terminalViewInput({ takeoverId, ...sealMessage(keys.w2d, takeoverId, "w2d", ++seq, Buffer.from(JSON.stringify({ events })), randomBytes(12)) });
  assert.equal(send([{ t: "tty", text: "echo owner-$((6*7))" }, { t: "tty-key", key: "Enter" }]), true);
  await until(() => opened().some((row) => /^owner-42$/m.test(text(row.screen))), "the owner's command in a frame");
  // A replayed message is refused.
  const replay = sealMessage(keys.w2d, takeoverId, "w2d", seq, Buffer.from(JSON.stringify({ events: [{ t: "tty", text: "x" }] })));
  terminalViewInput({ takeoverId, ...replay });
  assert.equal(terminalViewStats(takeoverId)!.refused, 1);

  // At most 15 frames a second, only on change.
  const before = fake.frames.length;
  await live(fake.client, { action: "terminal_send", session, text: "for i in $(seq 1 200); do echo line $i; sleep 0.005; done\n", waitMs: 5_000 });
  assert.ok(fake.frames.length - before >= 2, "frames while it printed");
  const quiet = fake.frames.length;
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(fake.frames.length, quiet, "nothing changed, no frame");
  const t0 = Date.now();
  const burst = fake.frames.length;
  await live(fake.client, { action: "terminal_send", session, text: "for i in $(seq 1 400); do echo tick $i; sleep 0.0025; done\n", waitMs: 5_000 });
  const rate = (fake.frames.length - burst) / ((Date.now() - t0) / 1000);
  assert.ok(rate <= 16, `at most 15 frames a second (${rate.toFixed(1)})`);

  // Control: the node's typing waits; handed back, it types again. The node's own work shows in the frames.
  assert.equal(controlTerminalView(takeoverId, true), "control");
  const waits = await live(fake.client, { action: "terminal_send", session, text: "echo node\n" });
  assert.equal(waits.status, 409);
  assert.match(String(waits.raw.error), /taken control/);
  assert.equal(controlTerminalView(takeoverId, false), "watch");
  const back = await live(fake.client, { action: "terminal_send", session, text: "echo node-again\n" });
  assert.equal(back.status, 200);
  await until(() => opened().some((row) => /^node-again$/m.test(text(row.screen))), "the node's command in a frame");

  // The session ending ends the view; the relay hears why.
  await live(fake.client, { action: "terminal_close", session });
  await until(() => fake.states.some((row) => row.id === takeoverId), "the view's end");
  assert.equal(fake.states.find((row) => row.id === takeoverId)!.reason, "ended");
  assert.equal(terminalViewStats(takeoverId), null);
  assert.deepEqual(await endTerminalView(takeoverId, { done: false, reason: "stopped", tell: false }), { ended: false, signedIn: null });
});
