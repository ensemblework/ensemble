import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import xterm from "@xterm/headless";
import { DEFAULT_PREFS } from "./prefs.js";
import { RENDER_OPTIONS, takeScreen } from "./screen.js";
import { fakeApi, ops, tick } from "./testing.js";

// In CI, Ink draws nothing until the app exits; this test needs every frame. Ink reads CI once, on import.
process.env.CI = "false";
process.env.CONTINUOUS_INTEGRATION = "false";
const { render } = await import("ink");
const { App } = await import("./app.js");

/** A real terminal emulator standing in for stdout: what the person would see. A TTY turns \n into CR LF. */
class Screen extends EventEmitter {
  readonly isTTY = true;
  readonly terminal: InstanceType<typeof xterm.Terminal>;
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super();
    this.terminal = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true, convertEol: true });
  }
  write(data: string): boolean {
    this.terminal.write(data);
    return true;
  }
  /** The window is dragged to a new size: the terminal first, then the program is told. */
  resize(columns: number, rows: number) {
    this.terminal.resize(columns, rows);
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }
  async lines(): Promise<string[]> {
    await new Promise<void>((resolve) => this.terminal.write("", resolve));
    const buffer = this.terminal.buffer.active;
    return Array.from({ length: this.rows }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? "");
  }
}

/** Keys typed into the app, the way Ink reads a TTY. */
class Keys extends EventEmitter {
  readonly isTTY = true;
  private pending: string | null = null;
  setRawMode() {}
  setEncoding() {}
  ref() {}
  unref() {}
  resume() {}
  pause() {}
  read(): string | null {
    const data = this.pending;
    this.pending = null;
    return data;
  }
  type(data: string) {
    this.pending = data;
    this.emit("readable");
  }
}

/** The app on the screen: the tabs on the first row, one status line on the last row it uses. */
function assertWhole(lines: string[]) {
  const shown = lines.join("\n");
  assert.match(lines[0]!, /\[e\] Ensemble\s+Tasks\s+Chat/, shown);
  assert.equal(lines.filter((line) => line.includes("[e] Quick")).length, 1, shown);
  assert.match(lines.at(-2)!, /\[e\] Quick/, shown);
}

test("in a real terminal the tabs stay on the first row while the screen updates and the window resizes", async () => {
  const screen = new Screen(100, 30);
  const keys = new Keys();
  const giveBack = takeScreen(screen);
  const { api } = fakeApi();
  const app = render(
    <App api={api} folder="/work/app" version="0.3.2" account={{ email: null, paired: false, apiBase: "https://x" }} prefs={DEFAULT_PREFS} ops={ops} />,
    { ...RENDER_OPTIONS, patchConsole: false, stdout: screen as never, stderr: screen as never, stdin: keys as never },
  );
  // The status line fills in once settings load; then the menu opens and closes, and the tab changes.
  await tick(300);
  keys.type("/");
  await tick(100);
  keys.type("\u001B");
  await tick(100);
  keys.type("\t");
  await tick(150);
  assertWhole(await screen.lines());
  // Narrower and shorter (the sidebar goes), then wider and taller again.
  screen.resize(40, 24);
  await tick(200);
  assertWhole(await screen.lines());
  screen.resize(120, 36);
  await tick(200);
  assertWhole(await screen.lines());
  app.unmount();
  giveBack();
});

test("a terminal narrower than it says (a resize the program has not heard of yet) clips lines instead of scrolling", async () => {
  const screen = new Screen(40, 30);
  screen.terminal.resize(37, 30);
  const giveBack = takeScreen(screen);
  const { api } = fakeApi();
  const app = render(
    <App api={api} folder="/work/app" version="0.3.2" account={{ email: null, paired: false, apiBase: "https://x" }} prefs={DEFAULT_PREFS} ops={ops} />,
    { ...RENDER_OPTIONS, patchConsole: false, stdout: screen as never, stderr: screen as never, stdin: new Keys() as never },
  );
  await tick(300);
  const lines = await screen.lines();
  app.unmount();
  giveBack();
  assert.match(lines[0]!, /\[e\] Ensemble\s+Tasks\s+Chat/, lines.join("\n"));
});
