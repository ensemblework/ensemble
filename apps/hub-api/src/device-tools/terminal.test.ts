/**
 * A node's terminal screenshots (device-tools/terminal.ts, capture/screen.ts): the keys it types, a
 * terminal's screen as text and HTML (colours, bold, inverse, wide characters, escaped markup, secrets
 * hidden), and programs run in a pseudo-terminal in the sandbox: a full-screen one still drawing when
 * the screen is taken (then stopped), and one that reads a typed line and ends with its exit code,
 * each kept as a PNG of the node's evidence. The runs skip where this computer has no OS sandbox, no
 * `script` or no Chromium.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// Ensemble's data and workspace for this test, in the home folder (the sandbox does not grant the temporary folder's parents).
const base = mkdtempSync(join(homedir(), ".ensemble-node-terminal-"));
process.env.DATABASE_URL ??= "postgresql://localhost/unused";
process.env.ENSEMBLE_REMOTE_STATE_DIR = join(base, "data");
process.env.ENSEMBLE_WORKSPACE_ROOT = join(base, "ensemble-workspace");
process.env.ENSEMBLE_SECRET_KEY ??= randomBytes(32).toString("base64");

const { keyBytes, keyTokens, namedKey, ptyArgv, terminalEnv, runNodeTerminal } = await import("./terminal.js");
const { drawn, headlessTerminal, holdAlternateScreen, renderScreen } = await import("../capture/screen.js");
const { ownToolFolder } = await import("./folders.js");
const { prepareSandbox } = await import("../workspace/sandbox/spawn.js");
const { findChromium } = await import("../browser/chromium.js");
const { findOnPath } = await import("../capture/system.js");
const { shutdownCapture } = await import("../capture/index.js");
const { shutdownBrowser } = await import("../browser/index.js");

after(async () => {
  await shutdownCapture().catch(() => undefined);
  await shutdownBrowser().catch(() => undefined);
  rmSync(base, { recursive: true, force: true });
});

test("keys: text, named keys in braces, Ctrl and Alt, and arrows as the program asked for them", () => {
  const typed = keyTokens(["{Down}{Down}", "hello{Enter}", "{F10}", "{Ctrl+C}", "{ctrl-d}", "{Escape}", "{Tab}", "{PageDown}", "{Space}", "{Alt+x}", "{nope}", "{Shift+Tab}", "q"]).map((token) => keyBytes(token, false));
  assert.deepEqual(typed, ["\u001b[B", "\u001b[B", "hello", "\r", "\u001b[21~", "\u0003", "\u0004", "\u001b", "\t", "\u001b[6~", " ", "\u001bx", "{nope}", "\u001b[Z", "q"]);
  assert.deepEqual(["F1", "F4", "F5", "F12"].map((name) => namedKey(name)!.normal), ["\u001bOP", "\u001bOS", "\u001b[15~", "\u001b[24~"]);
  // Application cursor keys (htop, vim, less turn them on): arrows and Home/End as SS3, the rest as before.
  assert.equal(keyBytes(keyTokens(["{Up}"])[0]!, true), "\u001bOA");
  assert.equal(keyBytes(keyTokens(["{End}"])[0]!, true), "\u001bOF");
  assert.equal(keyBytes(keyTokens(["{PageUp}"])[0]!, true), "\u001b[5~");
  assert.deepEqual(namedKey("Ctrl+["), { normal: "\u001b" });
  assert.equal(namedKey("Ctrl+1"), null, "no control character for a digit");
});

test("the pseudo-terminal sets its size and runs the command through the shell only in the sandbox", () => {
  assert.deepEqual(ptyArgv("linux", { command: "htop", columns: 100, rows: 30, shell: true }), ["script", "-qfec", "stty cols 100 rows 30 2>/dev/null; exec /bin/sh -c 'htop'", "/dev/null"]);
  assert.deepEqual(ptyArgv("darwin", { command: "echo 'it''s'", columns: 80, rows: 24, shell: true }), ["script", "-q", "/dev/null", "/bin/sh", "-c", "stty cols 80 rows 24 2>/dev/null; exec /bin/sh -c 'echo '\\''it'\\'''\\''s'\\'''"]);
  assert.deepEqual(ptyArgv("linux", { command: "top -d 1", columns: 80, rows: 24, shell: false }).at(2), "stty cols 80 rows 24 2>/dev/null; exec 'top' '-d' '1'");
  assert.throws(() => ptyArgv("linux", { command: "ls | head", columns: 80, rows: 24, shell: false }), /not supported/);
  assert.deepEqual(terminalEnv(120, 32, "de_DE.UTF-8"), { TERM: "xterm-256color", COLORTERM: "truecolor", COLUMNS: "120", LINES: "32", LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8", SHELL: "/bin/sh" });
  assert.equal(terminalEnv(80, 24, "C").LANG, "C.UTF-8");
});

test("a screen: 16, 256 and true colours, bold, inverse, underline, wide characters and markup, as text and HTML", async () => {
  const term = await headlessTerminal(40, 6);
  term.write("\u001b[31mRED\u001b[0m \u001b[1;32mBOLD\u001b[0m \u001b[38;5;208mORANGE\u001b[0m \u001b[38;2;10;20;30mRGB\u001b[0m\r\n");
  term.write("\u001b[7mINV\u001b[0m \u001b[4mUND\u001b[0m \u001b[3mIT\u001b[0m \u001b[2mDIM\u001b[0m \u001b[44mBLUE\u001b[0m\r\n");
  term.write("宽字 <b>&\r\n");
  await drawn(term);
  const screen = renderScreen(term, { title: "top <1>", rules: {} });
  term.dispose();
  assert.equal(screen.text, "RED BOLD ORANGE RGB\nINV UND IT DIM BLUE\n宽字 <b>&");
  assert.equal(screen.hidden, false);
  assert.match(screen.html, /<span style="color:#cd3131">RED<\/span>/);
  assert.match(screen.html, /<span style="color:#23d18b;font-weight:bold">BOLD<\/span>/, "bold green is drawn bright");
  assert.match(screen.html, /<span style="color:#ff8700">ORANGE<\/span>/);
  assert.match(screen.html, /<span style="color:#0a141e">RGB<\/span>/);
  assert.match(screen.html, /<span style="color:#1e1e1e;background:#e5e5e5">INV<\/span>/, "inverse swaps the default colours");
  assert.match(screen.html, /<span style="text-decoration:underline">UND<\/span>/);
  assert.match(screen.html, /<span style="font-style:italic">IT<\/span>/);
  assert.match(screen.html, /<span style="opacity:.6">DIM<\/span>/);
  assert.match(screen.html, /<span style="background:#2472c8">BLUE<\/span>/);
  assert.match(screen.html, /<span class="w">宽<\/span><span class="w">字<\/span> &lt;b&gt;&amp;/);
  assert.match(screen.html, /<title>top &lt;1&gt;<\/title>/);
  assert.equal((screen.html.match(/<div class="r">/g) ?? []).length, 6, "every row of the screen, the empty ones too");
  assert.match(screen.html, /width:40ch/);
});

test("a full-screen program that quits leaves its last frame on the screen, not the empty main screen", async () => {
  const term = await headlessTerminal(30, 4);
  const held = holdAlternateScreen(term);
  term.write("$ htop\r\n\u001b[?1049h\u001b[H\u001b[2JCPU [|||  30%]\r\nMem [|    2G]\u001b[?1049l");
  await drawn(term);
  assert.equal(renderScreen(term, { rules: {} }).text, "CPU [|||  30%]\nMem [|    2G]");
  held.dispose();
  term.dispose();
});

test("a secret on the screen is hidden in its text and drawn without colours, even across a wrapped line", async () => {
  const term = await headlessTerminal(30, 4);
  term.write("key \u001b[33msk-live-abcdefghijklmnopqrstuvwxyz\u001b[0m\r\npass hunter2-hunter2\r\n");
  await drawn(term);
  const screen = renderScreen(term, { rules: { secretValues: ["hunter2-hunter2"] } });
  term.dispose();
  assert.equal(screen.hidden, true);
  assert.doesNotMatch(screen.text, /sk-live|hunter2/);
  assert.doesNotMatch(screen.html, /sk-live|abcdefgh|hunter2/);
  assert.match(screen.text, /\[redacted\]/);
  assert.match(screen.text, /pass \[hidden\]/);
});

/** A computer's client that keeps what it would upload. */
function fakeClient() {
  const uploads: Array<{ uploadId: string; meta: { kind: string; name: string; mime?: string | null; size: number }; bytes: Uint8Array }> = [];
  return { uploads, client: { uploadEvidenceFile: async (uploadId: string, meta: (typeof uploads)[number]["meta"], bytes: Uint8Array) => (uploads.push({ uploadId, meta, bytes }), { result: "stored" as const }) } };
}

/** The evidence table and saved secrets in memory. */
function memoryDb() {
  const rows: Array<Record<string, unknown>> = [];
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => row[key] === value);
  return {
    rows,
    runSecret: { findMany: async () => [] },
    jobEvidence: {
      count: async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, where)).length,
      findFirst: async ({ where }: { where: Record<string, unknown> }) => rows.find((row) => matches(row, where)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { jobId: null, nodeId: null, operation: null, held: false, holdReason: null, variantOf: null, variant: null, details: null, caption: null, requirementId: null, createdAt: new Date(), ...data };
        rows.push(row);
        return row;
      },
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
    },
  };
}

const nodeId = "5c0ffee0-0000-4000-8000-00000000c0de";
const call = (over: Record<string, unknown>) => ({ id: randomUUID(), tool: "terminal", seconds: 2, columns: 60, rows: 12, keys: [], operation: `node:${nodeId}:conversation:terminal-test`, uploadId: "upload-1", network: false, nodeId, nodeSlug: "tester", mission: "m", attended: false, grants: [], ...over });

const caps = await prepareSandbox();
const skipRun = !caps.osSandbox ? `no OS sandbox here: ${caps.reason}` : !findOnPath("script") ? "no `script` here" : !findChromium({ headless: true }) ? "no Chromium here (`ensemble capture setup`)" : false;

test("a full-screen program still drawing is captured as a PNG of the node's evidence, then stopped", { skip: skipRun, timeout: 120_000 }, async () => {
  const folder = await ownToolFolder({ nodeId, nodeSlug: "tester" });
  const db = memoryDb();
  const fake = fakeClient();
  const answer = await runNodeTerminal({ prisma: db } as never, fake.client as never, call({ command: `sh -c 'printf "\\033[2J\\033[1;1HHELLO\\033[5;5H\\033[31mRED\\033[0m"; sleep 30'` }) as never, folder);
  assert.equal(answer.ok, true, JSON.stringify(answer.error));
  const result = answer.result as { screen: string; exitCode: number | null; ended: boolean };
  assert.deepEqual([result.ended, result.exitCode], [false, null], "still running when the screen was taken, so it was stopped");
  const lines = result.screen.split("\n");
  assert.equal(lines[0], "HELLO");
  assert.equal(lines[4], "    RED");
  assert.equal(answer.evidence.length, 1);
  assert.deepEqual([answer.evidence[0]!.kind, answer.evidence[0]!.held], ["screenshot", false]);
  assert.equal(answer.evidence[0]!.name, "terminal-sh.png");
  const upload = fake.uploads[0]!;
  assert.equal(upload.uploadId, "upload-1");
  assert.equal(upload.meta.mime, "image/png");
  assert.deepEqual([...upload.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(db.rows[0]!.operation, call({}).operation);
});

test("keys are typed into the program, and a program that ends gives its exit code", { skip: skipRun, timeout: 120_000 }, async () => {
  const folder = await ownToolFolder({ nodeId, nodeSlug: "tester" });
  const fake = fakeClient();
  const answer = await runNodeTerminal({ prisma: memoryDb() } as never, fake.client as never, call({ command: `sh -c 'read line; echo "got $line"; exit 3'`, keys: ["hello there{Enter}"], seconds: 10, title: "Reading a line" }) as never, folder);
  assert.equal(answer.ok, true, JSON.stringify(answer.error));
  const result = answer.result as { screen: string; exitCode: number | null; ended: boolean };
  assert.deepEqual([result.ended, result.exitCode], [true, 3]);
  assert.match(result.screen, /got hello there/);
  assert.equal(answer.evidence[0]!.name, "reading-a-line.png");
});

test("a program quit by a typed key is pictured as it last drew; an empty screen keeps no picture and says why", { skip: skipRun, timeout: 120_000 }, async () => {
  const folder = await ownToolFolder({ nodeId, nodeSlug: "tester" });
  const fake = fakeClient();
  const quit = await runNodeTerminal({ prisma: memoryDb() } as never, fake.client as never, call({ command: `sh -c 'stty -echo; printf "\\033[?1049h\\033[HTOP FRAME"; read key; printf "\\033[?1049l"'`, keys: ["q{Enter}"], seconds: 10 }) as never, folder);
  assert.equal(quit.ok, true, JSON.stringify(quit.error));
  assert.deepEqual([(quit.result as { ended: boolean }).ended, (quit.result as { screen: string }).screen], [true, "TOP FRAME"]);
  assert.equal(quit.evidence.length, 1);
  const empty = await runNodeTerminal({ prisma: memoryDb() } as never, fake.client as never, call({ command: "true", seconds: 5 }) as never, folder);
  assert.equal(empty.ok, false);
  assert.equal(empty.error?.code, "empty_screen");
  assert.match(empty.error?.message ?? "", /empty when the picture was taken.*leave the keys out/s);
  assert.equal(empty.evidence.length, 0);
  assert.equal(fake.uploads.length, 1, "only the frame was uploaded");
});
