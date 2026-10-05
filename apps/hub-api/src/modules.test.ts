import assert from "node:assert/strict";
import test from "node:test";
import { BadPathError, FULL_MODULE_SET, MODULE_DENIED, hasModule, kindAllowed, moduleDenied, moduleForPath, normalizePath, parseModules, serializeModules } from "@ensemble/shared-types";
import { toolAllowedFor, toolsFor } from "./assistant/registry.js";
import { buildSystemPrompt } from "./assistant/state.js";

const GATED: Array<[string, string]> = [
  ["/code", "code"],
  ["/code/review", "code"],
  ["/api/code/repos", "code"],
  ["/api/code/decide", "code"],
  ["/api/code/file", "code"],
  ["/api/code/scm/commit", "code"],
  ["/api/terminal/run", "code"],
  ["/api/terminal/status", "code"],
  ["/api/themes/search", "code"],
  ["/api/themes/openvsx", "code"],
  ["/diagrams", "diagrams"],
  ["/diagrams/abc", "diagrams"],
  ["/api/diagrams", "diagrams"],
  ["/api/diagrams/links", "diagrams"],
  ["/api/diagrams/abc/revisions", "diagrams"],
  ["/api/bridge/diagrams", "diagrams"],
  ["/api/bridge/diagrams/abc", "diagrams"],
  ["/api/bridge/repos/abc/overview", "code"],
  ["/api/bridge/repos/abc/file", "code"],
  ["/api/bridge/repos/:id/overview", "code"],
  ["/workspace", "workspace"],
  ["/api/workspace", "workspace"],
  ["/api/workspace/checkouts", "workspace"],
  ["/api/agent/assign", "workspace"],
  ["/api/agent/state", "workspace"],
  ["/api/agent/pause", "workspace"],
  ["/api/activity/abc/stop", "workspace"],
  ["/runs", "runs"],
  ["/api/runs", "runs"],
  ["/api/runs/abc", "runs"],
  ["/metrics", "metrics"],
  ["/api/metrics/summary", "metrics"],
  ["/api/ledger/verify", "metrics"],
  ["/skills", "skills"],
  ["/api/skills", "skills"],
  ["/api/skills/abc", "skills"],
  ["/api/bridge/skills", "skills"],
  ["/api/bridge/skills/abc", "skills"],
];

test("moduleForPath names every gated prefix and leaves core routes alone", () => {
  for (const [path, id] of GATED) assert.equal(moduleForPath(path), id, path);
  for (const path of ["/today", "/api/today/home", "/api/tasks", "/api/context/board", "/api/auth/me", "/marketplace", "/unavailable", "/api/bridge/repos", "/api/bridge/repos/abc"]) {
    assert.equal(moduleForPath(path), null, path);
  }
});

test("paths are normalised before the module is chosen", () => {
  const skills = [
    "/api/%73kills",
    "/api/%2573kills",
    "/API/SKILLS",
    "//api//skills",
    "/api/skills/",
    "/api/./skills",
    "/api/skills/../skills",
    "/api/skills;extra",
    "/api/skills?x=1",
    "/api/foo/../skills",
    "/api/%73kills%3bx",
  ];
  for (const path of skills) {
    assert.equal(moduleForPath(path), "skills", path);
    assert.equal(moduleDenied(path, ""), true, path);
    assert.equal(moduleDenied(path, FULL_MODULE_SET), false, path);
  }
  assert.equal(moduleForPath("/api/%63ode/reviews"), "code");
  assert.equal(moduleForPath("/api/run%73"), "runs");
  assert.equal(moduleForPath("/%63ode"), "code");
  assert.equal(moduleForPath("/api/skills/%2e%2e/code"), "code");
  assert.equal(normalizePath("/Code/"), "/code");
  assert.throws(() => normalizePath("/api/%"), BadPathError);
  assert.throws(() => normalizePath("/api/%zz"), BadPathError);
  assert.throws(() => moduleForPath("/api/%"), BadPathError);
  assert.equal(kindAllowed("", "skill"), false);
  assert.equal(kindAllowed(FULL_MODULE_SET, "skill"), true);
  assert.equal(kindAllowed("", "task"), true);
});

test("a null module set denies every optional module and a full set denies none", () => {
  assert.equal(parseModules(null).size, 0);
  assert.equal(hasModule(null, "code"), false);
  for (const [path] of GATED) assert.equal(moduleDenied(path, null), true);
  for (const [path] of GATED) assert.equal(moduleDenied(path, FULL_MODULE_SET), false);
  assert.equal(moduleDenied("/api/today/home", ""), false);
  assert.equal(serializeModules(["skills", "code", "nope"]), "code,skills");
  assert.equal(MODULE_DENIED, "Not part of this template.");
});

test("assistant tools for a removed module are dropped, reads of other areas stay", () => {
  const areas = ["tasks", "projects", "context", "skills", "reminders", "runs"] as const;
  const open = toolsFor(areas);
  const closed = toolsFor(areas, "");
  assert.ok(open.some((tool) => tool.area === "skills"));
  assert.equal(closed.some((tool) => tool.area === "skills" || tool.area === "runs"), false);
  assert.ok(closed.some((tool) => tool.area === "tasks"));
  assert.equal(toolsFor(areas).length, open.length);
});

const AREAS = ["tasks", "projects", "context", "skills", "reminders", "runs"] as const;
const DIAGRAM_TOOLS = ["hub_list_diagrams", "hub_create_diagram", "hub_edit_diagram", "hub_validate_diagram", "hub_diagram_context"];
const REPO_TOOLS = ["hub_repo_overview", "hub_repo_read_file"];
const toolNames = (modules?: string | null) => new Set(toolsFor(AREAS, modules).map((tool) => tool.name));
const EMPTY_STATE = { proposed: [], todo: [], inProgress: [], needsMe: [], projects: [], people: [], repos: [], skills: [] } as unknown as Parameters<typeof buildSystemPrompt>[0];

test("diagram tools follow the diagrams module and repo reads follow code", () => {
  for (const name of [...DIAGRAM_TOOLS, ...REPO_TOOLS]) {
    assert.ok(toolNames(FULL_MODULE_SET).has(name), name);
    assert.ok(toolNames(undefined).has(name), name);
    assert.equal(toolNames("skills,runs").has(name), false, name);
  }
  assert.ok(FULL_MODULE_SET.split(",").includes("diagrams"));
});

test("diagrams off: no diagram paths, tools, reads, or prompt, while code and repo reads stay", () => {
  const modules = "code,metrics,runs,skills,workspace";
  for (const path of ["/diagrams", "/diagrams/abc", "/api/diagrams", "/api/diagrams/abc", "/api/diagrams/links", "/api/bridge/diagrams/abc", "/api/%64iagrams"]) {
    assert.equal(moduleDenied(path, modules), true, path);
  }
  for (const path of ["/code", "/api/themes/search", "/api/bridge/repos/abc/overview", "/api/bridge/repos/abc/file", "/api/bridge/repos"]) {
    assert.equal(moduleDenied(path, modules), false, path);
  }
  assert.equal(kindAllowed(modules, "diagram"), false);
  const names = toolNames(modules);
  for (const name of DIAGRAM_TOOLS) assert.equal(names.has(name), false, name);
  for (const name of REPO_TOOLS) assert.ok(names.has(name), name);
  const byName = new Map(toolsFor(AREAS).map((tool) => [tool.name, tool]));
  assert.equal(toolAllowedFor(byName.get("hub_create_diagram")!, modules), false);
  assert.equal(toolAllowedFor(byName.get("hub_repo_overview")!, modules), true);
  const prompt = buildSystemPrompt(EMPTY_STATE, undefined, undefined, { diagrams: false, repos: true });
  assert.doesNotMatch(prompt, /hub_create_diagram|hub_diagram_context/);
});

test("code off with diagrams on: diagrams work, repo reads and themes do not", () => {
  const modules = "diagrams,metrics,runs,skills,workspace";
  for (const path of ["/diagrams", "/diagrams/abc", "/api/diagrams", "/api/diagrams/links", "/api/bridge/diagrams/abc"]) {
    assert.equal(moduleDenied(path, modules), false, path);
  }
  assert.equal(moduleForPath("/api/themes/search"), "code");
  for (const path of ["/code", "/api/themes/search", "/api/bridge/repos/abc/overview", "/api/bridge/repos/abc/file", "/api/code/repos"]) {
    assert.equal(moduleDenied(path, modules), true, path);
  }
  // The repo list itself is core: a diagram can still name a repo, it just cannot read it.
  assert.equal(moduleDenied("/api/bridge/repos", modules), false);
  assert.equal(kindAllowed(modules, "diagram"), true);
  const names = toolNames(modules);
  for (const name of DIAGRAM_TOOLS) assert.ok(names.has(name), name);
  for (const name of REPO_TOOLS) assert.equal(names.has(name), false, name);
  const byName = new Map(toolsFor(AREAS).map((tool) => [tool.name, tool]));
  assert.equal(toolAllowedFor(byName.get("hub_repo_read_file")!, modules), false);
  assert.equal(toolAllowedFor(byName.get("hub_edit_diagram")!, modules), true);
  const prompt = buildSystemPrompt(EMPTY_STATE, undefined, undefined, { diagrams: true, repos: false });
  assert.match(prompt, /hub_diagram_context/);
  assert.doesNotMatch(prompt, /hub_repo_overview/);
});
