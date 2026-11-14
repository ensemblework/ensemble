import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  addClaudeDesktopSession,
  claudeCodeTabFolder,
  claudeDesktopProfiles,
  codexAppOpen,
  codexProject,
  codexProjectThreads,
  fileCodexAppProject,
  removeClaudeDesktopSessions,
  removeCodexAppProjects,
  sessionTitle,
  stopCodexAppRetryForTests,
  syncCodexAppProjects,
} from "./app-sessions.js";

const CLI = "e005f1b8-90f8-48f1-b6e8-b4b05ccc6304";
const ACCOUNT = "0f608600-2872-453e-a82f-ba60382d75a4";
const ORG = "465f81e6-5ddc-4821-a3ef-c76586a14429";
const INSTALL = "babd862c-1122-4304-9076-e5044b7d4c36";
const LOCAL_ORG = "00000000-0000-4000-8000-000000000001";
const JUNE = new Date("2026-06-27T02:35:00Z");
const NOVEMBER = new Date("2026-11-14T04:50:00Z");

const scratch = (name: string) => mkdtempSync(join(tmpdir(), `${name}-`));
const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const touch = (path: string, when: Date) => utimesSync(path, when, when);
/** A Claude app profile with Chromium's Preferences, last run at `when`. */
function profile(path: string, when: Date): string {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "Preferences"), "{}");
  touch(join(path, "Preferences"), when);
  touch(path, when);
  return path;
}
/** A record the Claude app wrote itself, with fields of its own session. */
function appRecord(dir: string, id: string, when: Date, extra: Record<string, unknown> = {}): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `local_${id}.json`);
  writeFileSync(path, JSON.stringify({ sessionId: `local_${id}`, cliSessionId: `cli-${id}`, cwd: "/Users/me/theirs", originCwd: "/Users/me/theirs", folderPlace: { cwd: "/Users/me/theirs", realPath: "/Users/me/theirs" }, prs: [{ prNumber: 42 }], postTurnSummary: { status_category: "review_ready" }, lastAssistantCliSessionId: `cli-${id}`, shellFolders: ["/Users/me/theirs"], permissionMode: "bypassPermissions", title: "Theirs", titleSource: "auto", createdAt: 1, lastActivityAt: 2, ...extra }));
  touch(path, when);
  return path;
}

test("a session's title is one line of at most 80 characters", () => {
  assert.equal(sessionTitle("  Plan the\nlaunch  "), "Plan the launch");
  assert.equal(sessionTitle("x".repeat(100))?.length, 80);
  assert.equal(sessionTitle(""), null);
});

test("the Code tab's list is the one in the profile the Claude app runs on now, with the record of a session the app imported, and goes with the session", async () => {
  const home = scratch("claude-mac");
  try {
    const support = join(home, "Library", "Application Support");
    // The app signed in to a Claude account, last run in June, with Ensemble's entry from an older release.
    const signedIn = profile(join(support, "Claude"), JUNE);
    appRecord(join(signedIn, "claude-code-sessions", ACCOUNT, ORG), "june", JUNE);
    writeFileSync(join(signedIn, "claude-code-sessions", ACCOUNT, ORG, "local_old-ensemble.json"), JSON.stringify({ sessionId: "local_old-ensemble", cliSessionId: CLI, title: "App check 2" }));
    // The same app on a gateway (third-party mode), running now: its list has no record yet to copy.
    const gateway = profile(join(support, "Claude-3p"), NOVEMBER);
    const list = join(gateway, "claude-code-sessions", INSTALL, LOCAL_ORG);
    mkdirSync(list, { recursive: true });
    writeFileSync(join(list, "archived-sessions.idx"), "");
    profile(join(support, "Claude Extensions"), JUNE);
    mkdirSync(join(support, "claude-code"));
    // Folders made in a profile above moved its time to now (on coarse clocks, both to the same moment): set them again.
    touch(signedIn, JUNE);
    touch(gateway, NOVEMBER);

    const where = { home, platform: "darwin" as const, env: {} };
    assert.deepEqual((await claudeDesktopProfiles(where)).sort(), [join(support, "Claude"), join(support, "Claude Extensions"), join(support, "Claude-3p")].sort());
    assert.equal(await claudeCodeTabFolder(where), list, "the profile the app ran on last, not the June one");

    const file = await addClaudeDesktopSession({ ...where, cliSessionId: CLI, cwd: "/Users/me/ensemble-workspace/projects/launch", title: "Write the launch plan", model: "claude-haiku-5-5", now: 1000 });
    assert.equal(file, join(list, `local_${CLI}.json`));
    assert.deepEqual(json(file!), {
      sessionId: `local_${CLI}`,
      cliSessionId: CLI,
      cwd: "/Users/me/ensemble-workspace/projects/launch",
      originCwd: "/Users/me/ensemble-workspace/projects/launch",
      createdAt: 1000,
      lastActivityAt: 1000,
      indexedAt: 1000,
      isArchived: false,
      title: "Write the launch plan",
      model: "claude-haiku-5-5",
      sessionPermissionUpdates: [],
      alwaysAllowedReasons: [],
      adoptedFromOtherSurface: true,
      fromCliTranscript: true,
      filedBy: "ensemble",
    });
    assert.equal(await addClaudeDesktopSession({ ...where, cliSessionId: CLI, cwd: "/w", title: "Again" }), null, "listed once");
    assert.equal(await addClaudeDesktopSession({ ...where, cliSessionId: "not-a-session", cwd: "/w", title: "Bad id" }), null);
    assert.equal(await addClaudeDesktopSession({ ...where, cliSessionId: "11111111-2222-4333-8444-555555555555", cwd: "/w", title: null }), null, "no title, no record");

    assert.equal(await removeClaudeDesktopSessions(CLI, where), 2, "its record here and the older release's in the other profile");
    assert.deepEqual(readdirSync(list), ["archived-sessions.idx"]);
    assert.deepEqual(readdirSync(join(signedIn, "claude-code-sessions", ACCOUNT, ORG)), ["local_june.json"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a gateway profile whose Code tab was never opened files under the app's install id; a Claude account's is not guessed", async () => {
  const home = scratch("claude-3p");
  try {
    const support = join(home, "Library", "Application Support");
    const gateway = profile(join(support, "Claude-3p"), NOVEMBER);
    writeFileSync(join(gateway, "ant-did"), Buffer.from(INSTALL).toString("base64"));
    const where = { home, platform: "darwin" as const, env: {} };
    const file = await addClaudeDesktopSession({ ...where, cliSessionId: CLI, cwd: "/w/chat", title: "Ask about the launch" });
    assert.equal(file, join(gateway, "claude-code-sessions", INSTALL, LOCAL_ORG, `local_${CLI}.json`));

    const other = scratch("claude-1p");
    try {
      profile(join(other, "Library", "Application Support", "Claude"), NOVEMBER);
      assert.equal(await addClaudeDesktopSession({ home: other, platform: "darwin", env: {}, cliSessionId: CLI, cwd: "/w", title: "Plan" }), null, "no list on the account: nothing to file it under");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    assert.equal(await addClaudeDesktopSession({ home: scratch("no-claude"), platform: "darwin", env: {}, cliSessionId: CLI, cwd: "/w", title: "Plan" }), null, "no Claude app");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("with several lists in the profile, the one the app wrote to last; records Ensemble filed do not count", async () => {
  const home = scratch("claude-orgs");
  try {
    const support = join(home, "AppData", "Roaming");
    const signedIn = profile(join(support, "Claude"), NOVEMBER);
    const used = join(signedIn, "claude-code-sessions", ACCOUNT, ORG);
    const other = join(signedIn, "claude-code-sessions", INSTALL, "7ea99a9d-fb14-45fc-826a-cd23348af8d6");
    appRecord(used, "theirs", new Date("2026-11-13T10:00:00Z"));
    mkdirSync(other, { recursive: true });
    const ensembles = join(other, "local_ours.json");
    writeFileSync(ensembles, JSON.stringify({ sessionId: "local_ours", cliSessionId: "x", filedBy: "ensemble" }));
    touch(ensembles, NOVEMBER);
    writeFileSync(join(other, "scheduled-tasks.json"), "[]");
    touch(join(other, "scheduled-tasks.json"), JUNE);
    const where = { home, platform: "win32" as const, env: { APPDATA: support, LOCALAPPDATA: join(home, "AppData", "Local") } };
    assert.equal(await claudeCodeTabFolder(where), used);
    // Once the app saves the record itself (it drops `filedBy`), that list is the app's again.
    writeFileSync(ensembles, JSON.stringify({ sessionId: "local_ours", cliSessionId: "x" }));
    touch(ensembles, NOVEMBER);
    assert.equal(await claudeCodeTabFolder(where), other);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the Claude app's profiles on Windows (roaming, local third-party, Microsoft Store) and Linux", async () => {
  const home = scratch("claude-win");
  try {
    const roaming = join(home, "AppData", "Roaming");
    const local = join(home, "AppData", "Local");
    profile(join(roaming, "Claude"), JUNE);
    const gateway = profile(join(local, "Claude-3p"), NOVEMBER);
    const store = profile(join(local, "Claude-Data", "claude_pzs8sxrjxfjjc"), JUNE);
    const packaged = profile(join(local, "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude"), JUNE);
    mkdirSync(join(local, "claude-cli-nodejs"));
    const where = { home, platform: "win32" as const, env: { APPDATA: roaming, LOCALAPPDATA: local } };
    assert.deepEqual((await claudeDesktopProfiles(where)).sort(), [join(roaming, "Claude"), gateway, store, packaged].sort());
    writeFileSync(join(gateway, "ant-did"), Buffer.from(INSTALL).toString("base64"));
    assert.equal(await claudeCodeTabFolder(where), join(gateway, "claude-code-sessions", INSTALL, LOCAL_ORG));

    const config = join(home, ".config-xdg");
    const linux = profile(join(config, "Claude"), NOVEMBER);
    appRecord(join(linux, "claude-code-sessions", ACCOUNT, ORG), "theirs", NOVEMBER);
    assert.equal(await claudeCodeTabFolder({ home, platform: "linux", env: { XDG_CONFIG_HOME: config } }), join(linux, "claude-code-sessions", ACCOUNT, ORG));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an Ensemble project is one Codex project: found by Ensemble's id or its folder, renamed with it, else made once", async () => {
  const calls: Array<[string, unknown]> = [];
  const server = (rows: unknown[]) => ({
    request: async (method: string, params?: unknown) => {
      calls.push([method, params]);
      if (method === "project/list") return { data: rows };
      if (method === "project/create") return { project: { id: "new-project" } };
      return {};
    },
  });
  const project = { id: "p-1", name: "Launch", folder: "/w/projects/launch" };
  assert.equal(await codexProject(server([]), project), "new-project");
  assert.deepEqual(calls.at(-1), ["project/create", { name: "Launch", roots: [{ path: "/w/projects/launch" }], metadata: { ensembleProjectId: "p-1" }, idempotencyKey: "ensemble-project:p-1" }]);
  calls.length = 0;
  assert.equal(await codexProject(server([{ id: "c-1", name: "Old name", roots: [{ path: "/elsewhere" }], metadata: { ensembleProjectId: "p-1" } }]), project), "c-1");
  assert.deepEqual(calls.at(-1), ["project/update", { projectId: "c-1", name: "Launch" }]);
  calls.length = 0;
  assert.equal(await codexProject(server([{ id: "theirs", name: "Mine", roots: [{ path: "/w/projects/launch/" }] }]), project), "theirs", "a project the person made for the folder");
  assert.deepEqual(calls.map(([method]) => method), ["project/list"], "and it keeps the person's name");
  assert.equal(await codexProject({ request: async () => { throw new Error("Method not found: project/list"); } }, project), null, "an older Codex has no projects");

  // Its Codex project was deleted with the Ensemble project, which came back from Trash: Codex keeps the key with
  // the deleted project, so the next key makes a new one.
  calls.length = 0;
  const restored = {
    request: async (method: string, params?: unknown) => {
      calls.push([method, params]);
      if (method === "project/list") return { data: [] };
      const key = (params as { idempotencyKey?: string }).idempotencyKey;
      if (key === "ensemble-project:p-1") throw new Error("idempotency key refers to deleted project: ensemble-project:p-1");
      return { project: { id: "made-again" } };
    },
  };
  assert.equal(await codexProject(restored, project), "made-again");
  assert.deepEqual(calls.filter(([method]) => method === "project/create").map(([, params]) => (params as { idempotencyKey: string }).idempotencyKey), ["ensemble-project:p-1", "ensemble-project:p-1:2"]);
  // Found on a later page of Codex's projects.
  const paged = {
    request: async (method: string, params?: unknown) => {
      if (method !== "project/list") return assert.fail(`no ${method}`);
      return (params as { cursor?: string }).cursor === "page-2" ? { data: [{ id: "c-2", name: "Launch", metadata: { ensembleProjectId: "p-1" } }], nextCursor: null } : { data: [{ id: "other", name: "Other" }], nextCursor: "page-2" };
    },
  };
  assert.equal(await codexProject(paged, project), "c-2");

  const asked: unknown[] = [];
  assert.deepEqual(await codexProjectThreads({ request: async (_method, params) => (asked.push(params), { data: [{ id: "t-1" }, { id: 7 }, { id: "t-2" }] }) }, "c-1"), ["t-1", "t-2"]);
  assert.deepEqual(asked, [{ projectId: "c-1", archived: false, useStateDbOnly: true, limit: 100 }]);
  assert.deepEqual(await codexProjectThreads({ request: async () => { throw new Error("unknown method"); } }, "c-1"), []);
});

test("whether the ChatGPT app is open: Chromium's single-instance lock on macOS and Linux, its lockfile on Windows", async () => {
  const home = scratch("codex-lock");
  try {
    const mac = { home, platform: "darwin" as const, env: {}, processes: false };
    const data = join(home, "Library", "Application Support", "Codex");
    mkdirSync(data, { recursive: true });
    assert.equal(await codexAppOpen(mac), false, "no lock: closed");
    symlinkSync(`Akashs-MacBook-Air.local-${process.pid}`, join(data, "SingletonLock"));
    assert.equal(await codexAppOpen(mac), true, "the lock's process is running");
    rmSync(join(data, "SingletonLock"));
    symlinkSync("Akashs-MacBook-Air.local-2147483646", join(data, "SingletonLock"));
    assert.equal(await codexAppOpen(mac), false, "a lock left by a process that is gone");
    rmSync(join(data, "SingletonLock"));
    symlinkSync("unreadable", join(data, "SingletonLock"));
    assert.equal(await codexAppOpen(mac), true, "a lock it cannot read counts as open");

    const config = join(home, "xdg");
    mkdirSync(join(config, "Codex (Beta)"), { recursive: true });
    symlinkSync(`laptop-${process.pid}`, join(config, "Codex (Beta)", "SingletonLock"));
    assert.equal(await codexAppOpen({ home, platform: "linux", env: { XDG_CONFIG_HOME: config }, processes: false }), true, "another build of the app, on Linux");

    const roaming = join(home, "AppData", "Roaming");
    const local = join(home, "AppData", "Local");
    const win = { home, platform: "win32" as const, env: { APPDATA: roaming, LOCALAPPDATA: local }, processes: false };
    mkdirSync(join(roaming, "Codex"), { recursive: true });
    assert.equal(await codexAppOpen(win), false);
    const packaged = join(local, "Packages", "OpenAI.Codex_2p2nqsd0c76g0", "LocalCache", "Roaming", "Codex");
    mkdirSync(packaged, { recursive: true });
    writeFileSync(join(packaged, "lockfile"), "");
    assert.equal(await codexAppOpen(win), true, "a Microsoft Store build's lockfile");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const SERVER_ID = "01a1d4f6-4d1b-7e23-a424-e19b82364611";
/** The ChatGPT app's file as a person's own project leaves it, with keys Ensemble never touches. */
function sidebarState(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "desktop-first-seen-at-ms": 1791470115049,
    "local-projects": { "038badda-6afe-4e96-bbe5-6417efb7b753": { id: "038badda-6afe-4e96-bbe5-6417efb7b753", name: "EnsembleWork", rootPaths: ["/Users/me/EnsembleWork"], createdAt: 1, updatedAt: 1 } },
    "project-order": ["038badda-6afe-4e96-bbe5-6417efb7b753"],
    "app-server-project-id-by-legacy-project-id-by-host": { "local:/Users/me/.codex": { "038badda-6afe-4e96-bbe5-6417efb7b753": "01a1cafe-17e6-79d1-896b-d54f71063efb" } },
    "thread-project-assignments": { "theirs-thread": { projectKind: "local", projectId: "038badda-6afe-4e96-bbe5-6417efb7b753" } },
    "thread-project-membership-host-ids": { "theirs-thread": "local" },
    "projectless-thread-ids": ["set-apart"],
    "electron-main-window-bounds": { x: 0, y: 0, width: 1440, height: 900 },
    ...extra,
  };
}

function codexHomeWith(state: Record<string, unknown> | string | null): { home: string; codex: string; file: string; owed: string } {
  const home = scratch("codex-sidebar");
  const codex = join(home, ".codex");
  mkdirSync(codex, { recursive: true });
  const file = join(codex, ".codex-global-state.json");
  if (state !== null) writeFileSync(file, typeof state === "string" ? state : JSON.stringify(state));
  return { home, codex, file, owed: join(home, "state", "codex-app-projects.json") };
}

test("an Ensemble project and its threads go in the ChatGPT app's sidebar while the app is closed, and wait while it is open", async () => {
  const where = codexHomeWith(sidebarState());
  try {
    let open = true;
    const options = { home: where.home, platform: "darwin" as const, env: {}, state: where.owed, appOpen: async () => open, retryMs: null, now: 5000 };
    const project = { id: SERVER_ID, name: "Ensemble app check 2", folder: "/Users/me/ensemble-workspace/projects/ensemble-app-check-2", thread: "new-thread" };
    const before = readFileSync(where.file, "utf8");
    assert.equal(await fileCodexAppProject(project, { ...options, earlier: async () => ["earlier-thread", "theirs-thread", "set-apart"] }), "owed");
    assert.equal(readFileSync(where.file, "utf8"), before, "the open app's file is not touched");
    assert.deepEqual(json(where.owed)[SERVER_ID], { name: "Ensemble app check 2", folder: project.folder, threads: ["new-thread", "earlier-thread", "theirs-thread", "set-apart"] });

    open = false;
    assert.equal(await syncCodexAppProjects(options), "filed");
    const state = json(where.file);
    assert.deepEqual((state["local-projects"] as Record<string, unknown>)[SERVER_ID], { id: SERVER_ID, name: "Ensemble app check 2", rootPaths: [project.folder], createdAt: 5000, updatedAt: 5000 });
    assert.deepEqual(state["project-order"], ["038badda-6afe-4e96-bbe5-6417efb7b753", SERVER_ID]);
    assert.deepEqual(state["thread-project-assignments"], {
      "theirs-thread": { projectKind: "local", projectId: "038badda-6afe-4e96-bbe5-6417efb7b753" },
      "new-thread": { projectKind: "local", projectId: SERVER_ID },
      "earlier-thread": { projectKind: "local", projectId: SERVER_ID },
    }, "a thread already in a project, or set apart as projectless, stays where it is");
    assert.deepEqual(state["thread-project-membership-host-ids"], { "theirs-thread": "local", "new-thread": "local", "earlier-thread": "local" });
    assert.deepEqual(state["projectless-thread-ids"], ["set-apart"]);
    assert.deepEqual(state["app-server-project-id-by-legacy-project-id-by-host"], sidebarState()["app-server-project-id-by-legacy-project-id-by-host"], "the app maps its own ids");
    assert.deepEqual(state["electron-main-window-bounds"], { x: 0, y: 0, width: 1440, height: 900 });
    assert.equal(readFileSync(`${where.file}.bak`, "utf8"), readFileSync(where.file, "utf8"), "its backup copy too");
    assert.equal(await syncCodexAppProjects(options), "nothing", "nothing more owed");

    // The next task's thread joins it; a project renamed in Ensemble is renamed there.
    assert.equal(await fileCodexAppProject({ ...project, name: "App check", thread: "next-thread" }, { ...options, earlier: async () => assert.fail("asked only until filed") }), "filed");
    const renamed = json(where.file);
    assert.equal(((renamed["local-projects"] as Record<string, { name: string }>)[SERVER_ID])!.name, "App check");
    assert.deepEqual((renamed["thread-project-assignments"] as Record<string, unknown>)["next-thread"], { projectKind: "local", projectId: SERVER_ID });
    // Renamed by the person in the app: their name stays.
    const mine = json(where.file);
    (mine["local-projects"] as Record<string, { name: string }>)[SERVER_ID]!.name = "My name";
    writeFileSync(where.file, JSON.stringify(mine));
    await fileCodexAppProject({ ...project, name: "Launch", thread: "next-thread" }, options);
    assert.equal(((json(where.file)["local-projects"] as Record<string, { name: string }>)[SERVER_ID])!.name, "My name");
  } finally {
    rmSync(where.home, { recursive: true, force: true });
  }
});

test("a project the person removed in the ChatGPT app stays removed", async () => {
  const where = codexHomeWith(sidebarState());
  try {
    const options = { home: where.home, platform: "darwin" as const, env: {}, state: where.owed, appOpen: async () => false, retryMs: null, now: 5000 };
    const project = { id: SERVER_ID, name: "Launch", folder: "/w/projects/launch", thread: "t-1" };
    assert.equal(await fileCodexAppProject(project, options), "filed");
    // The person removes it: the app drops it from its list and moves its threads apart.
    writeFileSync(where.file, JSON.stringify(sidebarState({ "projectless-thread-ids": ["set-apart", "t-1"] })));
    assert.equal(await fileCodexAppProject({ ...project, thread: "t-2" }, options), "nothing");
    assert.equal(await fileCodexAppProject({ ...project, thread: "t-3" }, options), "nothing");
    const state = json(where.file);
    assert.equal(SERVER_ID in (state["local-projects"] as Record<string, unknown>), false);
    assert.equal((json(where.owed)[SERVER_ID] as { removed?: boolean }).removed, true);

    // Removed while it waited to be filed (the app's pending deletion, within its minute to undo): not filed.
    const waiting = codexHomeWith(sidebarState({ "app-server-pending-project-deletions-by-host": { "local:/Users/me/.codex": { [SERVER_ID]: { projectId: SERVER_ID, deleteAfterMs: 9 } } } }));
    try {
      assert.equal(await fileCodexAppProject(project, { ...options, home: waiting.home, state: waiting.owed }), "nothing");
      assert.equal(SERVER_ID in (json(waiting.file)["local-projects"] as Record<string, unknown>), false);
    } finally {
      rmSync(waiting.home, { recursive: true, force: true });
    }
  } finally {
    rmSync(where.home, { recursive: true, force: true });
  }
});

test("a Codex project the person already has for the folder keeps its own entry; Ensemble's threads join it", async () => {
  const where = codexHomeWith(sidebarState());
  try {
    const options = { home: where.home, platform: "darwin" as const, env: {}, state: where.owed, appOpen: async () => false, retryMs: null, now: 5000 };
    assert.equal(await fileCodexAppProject({ id: "01a1cafe-17e6-79d1-896b-d54f71063efb", name: "Ensemble's name", folder: "/Users/me/EnsembleWork", thread: "t-1" }, options), "filed");
    const state = json(where.file);
    assert.deepEqual(Object.keys(state["local-projects"] as Record<string, unknown>), ["038badda-6afe-4e96-bbe5-6417efb7b753"], "no second entry for the same project");
    assert.equal(((state["local-projects"] as Record<string, { name: string }>)["038badda-6afe-4e96-bbe5-6417efb7b753"])!.name, "EnsembleWork", "and the person's name");
    assert.deepEqual((state["thread-project-assignments"] as Record<string, unknown>)["t-1"], { projectKind: "local", projectId: "038badda-6afe-4e96-bbe5-6417efb7b753" });
  } finally {
    rmSync(where.home, { recursive: true, force: true });
  }
});

test("without the ChatGPT app's file, or with one it cannot read, Ensemble leaves it alone", async () => {
  const none = codexHomeWith(null);
  const broken = codexHomeWith("{\"local-projects\": {");
  try {
    const options = { platform: "darwin" as const, env: {}, appOpen: async () => false, retryMs: null };
    const project = { id: SERVER_ID, name: "Launch", folder: "/w", thread: "t-1" };
    assert.equal(await fileCodexAppProject(project, { ...options, home: none.home, state: none.owed }), "nothing");
    assert.equal(existsSync(none.owed), false, "nothing kept for an app that never ran here");
    assert.equal(await fileCodexAppProject(project, { ...options, home: broken.home, state: broken.owed }), "owed");
    assert.equal(readFileSync(broken.file, "utf8"), "{\"local-projects\": {");
    // A part Ensemble would change in a shape it does not know: nothing is rewritten.
    const odd = JSON.stringify(sidebarState({ "local-projects": [{ id: "x" }] }));
    writeFileSync(broken.file, odd);
    assert.equal(await syncCodexAppProjects({ ...options, home: broken.home, state: broken.owed }), "owed");
    assert.equal(readFileSync(broken.file, "utf8"), odd);
    // CODEX_HOME moves the file.
    const moved = codexHomeWith(sidebarState());
    try {
      assert.equal(await fileCodexAppProject(project, { ...options, home: none.home, env: { CODEX_HOME: moved.codex }, state: moved.owed }), "filed");
      assert.equal(SERVER_ID in (json(moved.file)["local-projects"] as Record<string, unknown>), true);
    } finally {
      rmSync(moved.home, { recursive: true, force: true });
    }
  } finally {
    stopCodexAppRetryForTests();
    rmSync(none.home, { recursive: true, force: true });
    rmSync(broken.home, { recursive: true, force: true });
  }
});

test("deleting its Ensemble project takes the project out of the ChatGPT app's sidebar once the app is closed, then out of Codex; its threads become projectless and nothing else changes", async () => {
  const theirs = "038badda-6afe-4e96-bbe5-6417efb7b753";
  const where = codexHomeWith(sidebarState({ "pinned-project-ids": [theirs] }));
  try {
    let open = false;
    const deleted: string[][] = [];
    const options = { home: where.home, platform: "darwin" as const, env: {}, state: where.owed, appOpen: async () => open, retryMs: null, now: 5000, deleteProjects: async (ids: string[]) => void deleted.push(ids) };
    const project = { id: SERVER_ID, name: "Launch", folder: "/w/projects/launch", thread: "new-thread" };
    assert.equal(await fileCodexAppProject(project, { ...options, earlier: async () => ["earlier-thread", "theirs-thread", "set-apart"] }), "filed");
    // The person pins it and moves a thread of their own into it in the app.
    const filed = json(where.file);
    filed["pinned-project-ids"] = [theirs, SERVER_ID];
    (filed["thread-project-assignments"] as Record<string, unknown>)["moved-in"] = { projectKind: "local", projectId: SERVER_ID };
    writeFileSync(where.file, JSON.stringify(filed));

    // The app is open: the file is not touched, and Codex keeps the project the app still shows.
    open = true;
    const before = readFileSync(where.file, "utf8");
    assert.equal(await removeCodexAppProjects([SERVER_ID], options), "owed");
    assert.equal(readFileSync(where.file, "utf8"), before);
    assert.equal(deleted.length, 0, "an app that shows it would make it again when it next starts");
    assert.deepEqual(json(where.owed)[SERVER_ID], { name: "Launch", folder: project.folder, threads: [], filedAt: 5000, filedName: "Launch", removed: true, deleting: true });

    open = false;
    assert.equal(await syncCodexAppProjects(options), "removed");
    const state = json(where.file);
    const expected = sidebarState({
      "pinned-project-ids": [theirs],
      "thread-project-membership-host-ids": { "theirs-thread": "local", "new-thread": "local", "earlier-thread": "local" },
      "projectless-thread-ids": ["set-apart", "new-thread", "earlier-thread", "moved-in"],
    });
    assert.deepEqual(state, expected, "out of the projects, their order and the pins; its threads set apart as projectless, the rest as it was");
    assert.equal(readFileSync(`${where.file}.bak`, "utf8"), readFileSync(where.file, "utf8"), "its backup copy too");
    assert.deepEqual(deleted, [[SERVER_ID]], "then out of Codex");
    assert.deepEqual(json(where.owed)[SERVER_ID], { name: "Launch", folder: project.folder, threads: [], filedAt: 5000, filedName: "Launch", removed: true });

    // Never filed again, and nothing more to do.
    const after = readFileSync(where.file, "utf8");
    assert.equal(await fileCodexAppProject({ ...project, thread: "late-thread" }, options), "nothing");
    assert.equal(await syncCodexAppProjects(options), "nothing");
    assert.equal(readFileSync(where.file, "utf8"), after);
    assert.deepEqual(deleted, [[SERVER_ID]]);
  } finally {
    rmSync(where.home, { recursive: true, force: true });
  }
});

test("a deleted project's Codex project that no sidebar shows goes from Codex at once; the person's own project stays; a refusal is tried again", async () => {
  const where = codexHomeWith(sidebarState());
  const none = codexHomeWith(null);
  try {
    const deleted: string[][] = [];
    const options = { home: where.home, platform: "darwin" as const, env: {}, state: where.owed, appOpen: async () => true, retryMs: null, now: 5000, deleteProjects: async (ids: string[]) => void deleted.push(ids) };
    // Still waiting to be filed while the app is open: the app has never shown it, so Codex deletes it now.
    assert.equal(await fileCodexAppProject({ id: SERVER_ID, name: "Launch", folder: "/w/projects/launch", thread: "t-1" }, options), "owed");
    const before = readFileSync(where.file, "utf8");
    assert.equal(await removeCodexAppProjects([SERVER_ID], options), "removed");
    assert.deepEqual(deleted, [[SERVER_ID]]);
    assert.equal(await syncCodexAppProjects({ ...options, appOpen: async () => false }), "nothing", "and it is never filed");
    assert.equal(readFileSync(where.file, "utf8"), before);

    // The app shows the Codex project as the person's own project for the folder: both stay.
    deleted.length = 0;
    assert.equal(await removeCodexAppProjects(["01a1cafe-17e6-79d1-896b-d54f71063efb"], { ...options, appOpen: async () => false }), "removed");
    assert.equal(deleted.length, 0);
    assert.equal(readFileSync(where.file, "utf8"), before);

    // No ChatGPT app here: Codex deletes it at once.
    assert.equal(await removeCodexAppProjects(["other-project"], { ...options, home: none.home, state: none.owed }), "removed");
    assert.deepEqual(deleted, [["other-project"]]);
    assert.deepEqual(json(none.owed)["other-project"], { name: "", folder: "", threads: [], removed: true });

    // Codex refuses for now: owed, and done on the next try.
    let refuse = true;
    const flaky = { ...options, home: none.home, state: none.owed, deleteProjects: async (ids: string[]) => (refuse ? Promise.reject(new Error("Codex did not start")) : void deleted.push(ids)) };
    assert.equal(await removeCodexAppProjects(["third-project"], flaky), "owed");
    assert.equal((json(none.owed)["third-project"] as { deleting?: boolean }).deleting, true);
    refuse = false;
    assert.equal(await syncCodexAppProjects(flaky), "removed");
    assert.deepEqual(deleted.at(-1), ["third-project"]);
    assert.equal(await removeCodexAppProjects([], flaky), "nothing");
  } finally {
    stopCodexAppRetryForTests();
    rmSync(where.home, { recursive: true, force: true });
    rmSync(none.home, { recursive: true, force: true });
  }
});
