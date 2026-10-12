import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import xterm from "@xterm/headless";
import { render } from "ink";
import { App } from "./app.js";
import { DEFAULT_PREFS } from "./prefs.js";
import { ALT_ON, RENDER_OPTIONS } from "./screen.js";
import { fakeApi, ops, tick } from "./testing.js";

/** A real terminal emulator, 100×30, standing in for stdout: what the person would see. A TTY turns \n into CR LF. */
class Screen extends EventEmitter {
  readonly isTTY = true;
  readonly columns = 100;
  readonly rows = 30;
  readonly terminal = new xterm.Terminal({ cols: 100, rows: 30, allowProposedApi: true, convertEol: true });
  write(data: string): boolean {
    this.terminal.write(data);
    return true;
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

test("in a real terminal the tabs stay on the first row while the screen updates", async () => {
  const screen = new Screen();
  const keys = new Keys();
  screen.write(ALT_ON);
  const { api } = fakeApi();
  const app = render(
    <App api={api} folder="/work/app" version="0.3.1" account={{ email: null, paired: false, apiBase: "https://x" }} prefs={DEFAULT_PREFS} ops={ops} />,
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
  const lines = await screen.lines();
  app.unmount();
  assert.match(lines[0]!, /◆ Ensemble\s+Tasks\s+Chat/);
  assert.equal(lines.filter((line) => line.includes("◆ Quick")).length, 1, lines.join("\n"));
  assert.match(lines.at(-2)!, /◆ Quick/);
});
