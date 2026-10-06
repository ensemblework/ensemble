import { setTestUrl } from "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Settings } from "@ensemble/shared-types";
import { TERMINAL_DESKTOP_BODY, TERMINAL_DESKTOP_TITLE } from "../code/terminal-desktop-note.js";
import { AutonomySection, OrchestrationSection, QuietHoursSection, TerminalSection } from "./sections.js";

// sections.tsx and ui.tsx are compiled with the classic JSX runtime under tsx, so they need React in scope here.
(globalThis as { React?: typeof React }).React = React;

type DesktopWindow = Window & {
  __ENSEMBLE_DESKTOP__?: { apiBase?: string };
  __TAURI__?: { dialog?: { open: (options: unknown) => Promise<string | null> } };
};

const STATUS = { enabled: true, unlocked: false, expiresAt: null, passkeys: [], roots: ["/work"], home: "/work" };
// Each list has a folder the other does not, so a section showing the wrong list is caught.
const SETTINGS = Settings.parse({ terminal: { roots: ["/srv/terminal-only"] }, code: { roots: ["/srv/code-only"] } });

test("agent limits and quiet-hour fields have contextual accessible labels", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<>
      <AutonomySection settings={SETTINGS} patch={() => {}} />
      <OrchestrationSection settings={SETTINGS} patch={() => {}} />
      <QuietHoursSection settings={SETTINGS} patch={() => {}} />
    </>));
    for (const input of host.querySelectorAll("input,select")) {
      assert.ok(input.getAttribute("aria-label") || input.getAttribute("aria-labelledby"), input.outerHTML);
    }
    for (const name of ["Daily high-risk write limit", "Tasks that run at once", "Quiet hours start", "Quiet hours end"]) {
      assert.ok(host.querySelector(`[aria-label="${name}"]`), name);
    }
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

type Patch = Record<string, unknown>;
type View = { host: HTMLDivElement; calls: string[]; patches: Patch[]; done: () => Promise<void> };

/** POST /api/code/folders/resolve refuses /etc (as hub-api does) and returns "<path>-real" for anything else. */
async function mount(): Promise<View> {
  const calls: string[] = [];
  const patches: Patch[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.endsWith("/api/code/folders/resolve")) {
      const path = String((JSON.parse(String(init?.body ?? "{}")) as { path?: string }).path ?? "");
      const refused = path === "/etc";
      return new Response(JSON.stringify(refused ? { error: "/etc holds the operating system or installed apps." } : { path: `${path}-real` }), {
        status: refused ? 403 : 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const body = url.endsWith("/api/terminal/status") ? STATUS : url.endsWith("/api/code/repos") ? { repos: [], roots: ["/work"] } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The Code module is on, so the section renders (useModuleOn reads the shell query).
  client.setQueryData(["shell"], { modules: "code" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TerminalSection settings={SETTINGS} patch={(value) => patches.push(value as Patch)} />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  return {
    host,
    calls,
    patches,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
      globalThis.fetch = realFetch;
    },
  };
}

async function at(url: string, desktop: boolean, check: (view: View) => void | Promise<void>): Promise<void> {
  setTestUrl(url);
  if (desktop) (window as DesktopWindow).__ENSEMBLE_DESKTOP__ = { apiBase: "http://127.0.0.1:1" };
  try {
    const view = await mount();
    try {
      await check(view);
    } finally {
      await view.done();
    }
  } finally {
    delete (window as DesktopWindow).__ENSEMBLE_DESKTOP__;
    delete (window as DesktopWindow).__TAURI__;
    setTestUrl("http://localhost/");
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function click(element: Element | null, label: string): Promise<void> {
  assert.equal(element !== null, true, `${label}: element exists`);
  await act(async () => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

async function type(input: HTMLInputElement | null, value: string): Promise<void> {
  assert.equal(input !== null, true, "the Code folder field exists");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const desktopNote = (host: HTMLElement) => host.querySelector('[data-testid="terminal-desktop-note"]');
const addressNote = (host: HTMLElement) => host.querySelector('[data-testid="terminal-address-note"]');
// Booleans, not elements: a failing assert would otherwise try to print a whole jsdom node.
const hasToggle = (host: HTMLElement) => host.querySelector('[aria-label="Terminal"]') !== null;
const hasDesktopNote = (host: HTMLElement) => desktopNote(host) !== null;
const hasAddressNote = (host: HTMLElement) => addressNote(host) !== null;
const text = (host: HTMLElement) => host.textContent ?? "";

/** Settings rows that have nothing to do with where the terminal runs stay on every build. */
function assertCommitSettingsStay(host: HTMLElement, label: string) {
  for (const row of ["Branch prefix for agent work", "Commit author", "Sign commits", "Keep reviewed code on this device"]) {
    assert.ok(text(host).includes(row), `${label}: ${row}`);
  }
}

/** The terminal's folder list follows the same rule as the toggle: only where the terminal can open. */
function assertFolders(view: { host: HTMLElement; calls: string[] }, shown: boolean, label: string) {
  assert.equal(text(view.host).includes("Folders the terminal can use"), shown, `${label}: folders heading`);
  assert.equal(text(view.host).includes("Allow folder"), shown, `${label}: Allow folder button`);
  assert.equal(view.host.querySelector('input[placeholder="/Users/you/another-folder"]') !== null, shown, `${label}: folder field`);
  // The terminal's list shows the terminal's folders only, never the Code list.
  const block = terminalFolders(view.host);
  assert.equal(block.includes("/srv/terminal-only"), shown, `${label}: terminal folder listed`);
  assert.equal(block.includes("/srv/code-only"), false, `${label}: the terminal list must not show code.roots`);
}

/** Everything in the section outside the Code folders block. */
function terminalFolders(host: HTMLElement): string {
  const clone = host.cloneNode(true) as HTMLElement;
  clone.querySelector('[data-testid="code-folders"]')?.remove();
  return clone.textContent ?? "";
}

const codeBlock = (host: HTMLElement) => host.querySelector('[data-testid="code-folders"]');
const codeField = (host: HTMLElement) => host.querySelector<HTMLInputElement>('input[aria-label="Folder path for Code"]');
const codeAdd = (host: HTMLElement) => Array.from(codeBlock(host)?.querySelectorAll("button") ?? []).find((button) => button.textContent === "Add folder") ?? null;
const codeChoose = (host: HTMLElement) => host.querySelector('[data-testid="code-folder-choose"]');

/** "Folders Code can use" is on every address where the Code tab works, desktop included, and lists only code.roots. */
function assertCodeFolders(view: View, desktop: boolean, label: string) {
  assert.equal(codeBlock(view.host) !== null, true, `${label}: Code folders block`);
  const block = codeBlock(view.host)?.textContent ?? "";
  assert.equal(block.includes("Folders Code can use"), true, `${label}: heading`);
  assert.equal(block.includes("/srv/code-only"), true, `${label}: the Code folder is listed`);
  assert.equal(block.includes("/srv/terminal-only"), false, `${label}: the Code list must not show terminal.roots`);
  assert.equal(codeField(view.host) !== null, true, `${label}: path field`);
  assert.equal(codeAdd(view.host) !== null, true, `${label}: Add folder`);
  assert.equal(codeChoose(view.host) !== null, desktop, `${label}: native Choose folder button only on desktop`);
  // It comes after the terminal note (desktop or address), as the Mac check expects.
  const note = view.host.querySelector('[data-testid="terminal-desktop-note"], [data-testid="terminal-address-note"]');
  if (note) assert.equal(Boolean(note.compareDocumentPosition(codeBlock(view.host)!) & Node.DOCUMENT_POSITION_FOLLOWING), true, `${label}: after the note`);
}

test("desktop Settings: the note, then the commit settings; no Terminal toggle, folder list or Touch ID set-up line that would contradict it", async () => {
  await at("http://127.0.0.1:1430/settings", true, (view) => {
    assert.equal(hasDesktopNote(view.host), true, "desktop note is shown");
    const note = desktopNote(view.host)?.textContent ?? "";
    assert.ok(note.includes(TERMINAL_DESKTOP_TITLE));
    assert.ok(note.includes(TERMINAL_DESKTOP_BODY));
    assert.equal(hasToggle(view.host), false, "no Terminal toggle");
    assert.equal(text(view.host).includes("Terminal on"), false);
    assert.equal(text(view.host).includes("Touch ID passkeys"), false);
    assert.equal(text(view.host).includes("Open the terminal in the Code tab"), false);
    // The desktop note wins over the address (the webview is on an IP-like origin).
    assert.equal(hasAddressNote(view.host), false);
    assert.equal(view.calls.some((url) => url.endsWith("/api/terminal/status")), false, `no status call: ${view.calls.join(", ")}`);
    assertFolders(view, false, "desktop");
    assertCodeFolders(view, true, "desktop");
    assertCommitSettingsStay(view.host, "desktop");
  });
});

test("web Settings on localhost: no desktop note, and the toggle, folder list and passkey set-up line as before", async () => {
  await at("http://localhost:3000/settings", false, (view) => {
    assert.equal(hasDesktopNote(view.host), false);
    assert.equal(text(view.host).includes(TERMINAL_DESKTOP_TITLE), false);
    assert.equal(hasAddressNote(view.host), false);
    assert.equal(hasToggle(view.host), true, "Terminal toggle");
    assert.ok(text(view.host).includes("Touch ID passkeys"));
    assert.ok(text(view.host).includes("None yet. Open the terminal in the Code tab to set one up."));
    assert.ok(view.calls.some((url) => url.endsWith("/api/terminal/status")), `status was fetched: ${view.calls.join(", ")}`);
    assertFolders(view, true, "localhost");
    assertCodeFolders(view, false, "localhost");
    assertCommitSettingsStay(view.host, "localhost");
  });
});

test("web Settings where the terminal cannot open: no desktop note, the Code tab's address message instead of the toggle, folders and set-up", async () => {
  const cases: Array<[string, string, RegExp]> = [
    ["https://app.ensemblework.com/settings", "named-host", /not available at app\.ensemblework\.com yet/],
    ["http://127.0.0.1:3100/settings", "loopback-ip", /Open Ensemble at http:\/\/localhost:3100 to use the terminal/],
    ["http://192.168.1.20:3000/settings", "ip", /only on the computer running Ensemble/],
  ];
  for (const [url, reason, says] of cases) {
    await at(url, false, (view) => {
      assert.equal(hasDesktopNote(view.host), false, url);
      assert.equal(text(view.host).includes(TERMINAL_DESKTOP_TITLE), false, url);
      assert.equal(hasAddressNote(view.host), true, `${url}: address note`);
      assert.equal(addressNote(view.host)?.getAttribute("data-reason"), reason, url);
      assert.match(addressNote(view.host)?.textContent ?? "", says, url);
      assert.equal(hasToggle(view.host), false, `${url}: no Terminal toggle`);
      assert.equal(text(view.host).includes("Open the terminal in the Code tab"), false, url);
      assert.equal(view.calls.some((call) => call.endsWith("/api/terminal/status")), false, url);
      assertFolders(view, false, url);
      assertCodeFolders(view, false, url);
      assertCommitSettingsStay(view.host, url);
    });
  }
});

test("adding and removing a Code folder saves code.roots only, after hub-api checks it", async () => {
  for (const url of ["http://localhost:3000/settings", "https://app.ensemblework.com/settings", "http://127.0.0.1:3100/settings", "http://192.168.1.20:3000/settings"]) {
    await at(url, false, async (view) => {
      await type(codeField(view.host), "/etc");
      await click(codeAdd(view.host), `${url}: add /etc`);
      assert.equal(view.patches.length, 0, `${url}: a refused folder is not saved`);
      assert.match(codeBlock(view.host)?.querySelector('[role="alert"]')?.textContent ?? "", /operating system/, `${url}: the refusal is shown`);

      await type(codeField(view.host), "/srv/new");
      await click(codeAdd(view.host), `${url}: add /srv/new`);
      assert.ok(view.calls.some((call) => call.endsWith("/api/code/folders/resolve")), `${url}: checked by hub-api`);
      assert.deepEqual(view.patches, [{ code: { roots: ["/srv/code-only", "/srv/new-real"] } }], `${url}: saved as the real path, in code.roots only`);

      await click(codeBlock(view.host)?.querySelector('[aria-label="Remove /srv/code-only"]') ?? null, `${url}: remove`);
      assert.deepEqual(view.patches[1], { code: { roots: [] } }, `${url}: removal saves code.roots only`);
      assert.equal(view.patches.some((value) => "terminal" in value), false, `${url}: the terminal list is never written`);
    });
  }
});

test("desktop: Choose folder… opens the native picker and saves the chosen folder to code.roots", async () => {
  const asked: unknown[] = [];
  await at("http://127.0.0.1:1430/settings", true, async (view) => {
    (window as DesktopWindow).__TAURI__ = {
      dialog: {
        open: async (options) => {
          asked.push(options);
          return "/Users/prajwal/src";
        },
      },
    };
    await click(codeChoose(view.host), "Choose folder…");
    assert.equal(asked.length, 1, "the native picker opened");
    assert.deepEqual((asked[0] as { directory?: boolean }).directory, true);
    assert.deepEqual(view.patches, [{ code: { roots: ["/srv/code-only", "/Users/prajwal/src-real"] } }]);
  });
  // No native picker (a plain browser pointed at the desktop API): say so, save nothing.
  await at("http://127.0.0.1:1430/settings", true, async (view) => {
    await click(codeChoose(view.host), "Choose folder… without a picker");
    assert.equal(view.patches.length, 0);
    assert.match(codeBlock(view.host)?.querySelector('[role="alert"]')?.textContent ?? "", /no folder picker here/);
  });
});
