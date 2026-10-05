/**
 * Live end-to-end test for the read-only Context Bridge.
 *
 * Brings up Postgres + Redis, pushes the schema, seeds, starts hub-api,
 * mints a real `ens_` bridge token, then drives the built server with the
 * official MCP SDK over stdio (the same command the editor configs use)
 * and over Streamable HTTP. Compares tool and resource payloads to the
 * live Hub, then checks the read-only and auth boundaries.
 *
 *   pnpm bridge:e2e
 *
 * Writes a JSON report to bridge-e2e-report.json in the repo root (gitignored
 * if you add it) and, when present, /opt/cursor/artifacts/bridge-e2e-report.json.
 * The full console log is the human-readable record.
 */
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { createConnection } from "node:net";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TOOL_NAMES } from "../src/server.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "../../..");
const dist = resolve(root, "apps/context-bridge/dist/index.js");
const hub = "http://127.0.0.1:4000";
const bridgeHttp = "http://127.0.0.1:4010/mcp";
const logDir = "/tmp/ensemble-bridge-e2e";
const BRANCH_TASK = "Clarify the default timeout in the README";
const AMBIGUOUS = ["Split the retry budget", "Log retry reasons"];
const FIXED_URIS = [
  "ensemble://today",
  "ensemble://tasks",
  "ensemble://projects",
  "ensemble://repos",
  "ensemble://skills",
  "ensemble://deliverables",
  "ensemble://meetings",
  "ensemble://people",
  "ensemble://decisions",
  "ensemble://gaps",
];
const TEMPLATE_URIS = [
  "ensemble://tasks/{id}",
  "ensemble://projects/{id}",
  "ensemble://repos/{id}",
  "ensemble://skills/{id}",
  "ensemble://people/{id}",
  "ensemble://items/{kind}/{id}",
];

interface Check {
  group: string;
  name: string;
  pass: boolean;
  sample: string;
}

const checks: Check[] = [];
const friction: string[] = [];

function record(group: string, name: string, pass: boolean, sample: string): void {
  const clean = sample.replace(/\s+/g, " ").trim().slice(0, 400);
  checks.push({ group, name, pass, sample: clean });
  console.log(`${pass ? "PASS" : "FAIL"}  [${group}] ${name}`);
  if (clean) console.log(`      ${clean}`);
}

function loadEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function ensureEnvFile(): Record<string, string> {
  const path = resolve(root, ".env");
  if (!existsSync(path)) {
    writeFileSync(
      path,
      [
        "DATABASE_URL=postgresql://ensemble:ensemble@127.0.0.1:5432/ensemble",
        "REDIS_URL=redis://127.0.0.1:6379",
        "HUB_API_HOST=127.0.0.1",
        "HUB_API_PORT=4000",
        "HUB_WEB_ORIGIN=http://localhost:3000",
        "ENSEMBLE_DEV_AUTH_BYPASS=true",
        "ENSEMBLE_DEV_USER_ID=local",
        "ENSEMBLE_TIMEZONE=Asia/Kolkata",
        "ENSEMBLE_WORKSPACE_ROOT=/tmp/ensemble-workspace",
        "",
      ].join("\n"),
    );
    friction.push("Created a local .env (gitignored). Prisma CLI does not read it; this script exports DATABASE_URL itself.");
  }
  const file = loadEnvFile(path);
  const defaults: Record<string, string> = {
    DATABASE_URL: "postgresql://ensemble:ensemble@127.0.0.1:5432/ensemble",
    REDIS_URL: "redis://127.0.0.1:6379",
    HUB_API_HOST: "127.0.0.1",
    HUB_API_PORT: "4000",
    HUB_WEB_ORIGIN: "http://localhost:3000",
    ENSEMBLE_DEV_AUTH_BYPASS: "true",
    ENSEMBLE_DEV_USER_ID: "local",
    ENSEMBLE_TIMEZONE: "Asia/Kolkata",
    ENSEMBLE_WORKSPACE_ROOT: "/tmp/ensemble-workspace",
  };
  return { ...defaults, ...file, ...process.env } as Record<string, string>;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd = root): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

function capture(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => resolvePromise({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("exit", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

let dockerPrefix: string[] | null = null;

async function docker(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  if (!dockerPrefix) {
    const direct = spawnSync("docker", ["info"], { stdio: "ignore" });
    if (direct.status === 0) dockerPrefix = [];
    else {
      friction.push("The docker CLI cannot reach the daemon without sudo (this user is not in the docker group).");
      dockerPrefix = ["sudo"];
    }
  }
  const command = dockerPrefix.length ? dockerPrefix[0]! : "docker";
  const commandArgs = dockerPrefix.length ? ["docker", ...args] : args;
  await run(command, commandArgs, env);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForHttp(url: string, ms = 40_000): Promise<void> {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < ms) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
      last = `${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(400);
  }
  throw new Error(`Timed out waiting for ${url} (${last})`);
}

function spawnBackground(name: string, command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): void {
  mkdirSync(logDir, { recursive: true });
  const log = createWriteStream(resolve(logDir, `${name}.log`), { flags: "a" });
  const options: SpawnOptions = { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] };
  const child = spawn(command, args, options);
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  child.unref();
  writeFileSync(resolve(logDir, `${name}.pid`), `${child.pid}\n`);
  console.log(`started ${name} pid ${child.pid} → ${logDir}/${name}.log`);
}

async function freePort(port: number): Promise<void> {
  const listed = spawnSync("sudo", ["ss", "-ltnp"], { encoding: "utf8" });
  const pids = new Set<string>();
  for (const line of `${listed.stdout ?? ""}\n${listed.stderr ?? ""}`.split("\n")) {
    if (!line.includes(`:${port}`)) continue;
    for (const match of line.matchAll(/pid=(\d+)/g)) pids.add(match[1]!);
  }
  if (pids.size === 0) return;
  friction.push(`Port ${port} was already in use; stopped pid ${[...pids].join(",")} so this run owns it.`);
  for (const pid of pids) spawnSync("sudo", ["kill", pid], { stdio: "ignore" });
  await sleep(500);
}

function textOf(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
  return result.content
    .map((block) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseTool(result: unknown): { error?: string; data: Record<string, unknown>; text: string } {
  const text = textOf(result);
  const isError = Boolean(result && typeof result === "object" && "isError" in result && result.isError);
  if (isError) return { error: text || "tool error", data: {}, text };
  const structured = result && typeof result === "object" && "structuredContent" in result ? result.structuredContent : undefined;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    return { data: structured as Record<string, unknown>, text };
  }
  try {
    return { data: asRecord(JSON.parse(text)), text };
  } catch {
    return { error: `response was not JSON: ${text.slice(0, 180)}`, data: {}, text };
  }
}

async function connectStdio(env: Record<string, string>): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [dist],
    cwd: root,
    stderr: "pipe",
    env: { ...getDefaultEnvironment(), ...env },
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: "ensemble-bridge-live-e2e", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
      if (stderr.trim()) console.log(`stdio stderr: ${stderr.trim().slice(0, 500)}`);
    },
  };
}

interface Snap {
  tasks: Array<{ id: string; title: string; status: string }>;
  people: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; name: string; deliverables?: Array<{ id: string; title: string; status: string }> }>;
  repos: Array<{ id: string; fullName: string }>;
  skills: Array<{ id: string; name: string; enabled?: boolean }>;
  documents: Array<{ id: string; filename: string }>;
  approvals: Array<{ id: string; title: string }>;
  decisions: Array<{ id: string; title: string; status?: string }>;
  meetings: Array<{ id: string; title: string }>;
  meetingNotes: Array<{ id: string; title: string }>;
  upcomingDeliverables: Array<{ id: string; title: string }>;
}

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const response = await fetch(`${hub}${path}`, {
    method,
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    const parsed = text ? JSON.parse(text) : {};
    json = asRecord(parsed);
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json, text };
}

function list<T>(json: Record<string, unknown>, key: string): T[] {
  const value = json[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

async function ensureApiFixtures(): Promise<void> {
  const docs = await api("GET", "/api/documents");
  const filenames = list<{ filename: string }>(docs.json, "documents").map((row) => row.filename);
  if (!filenames.includes("latency-readout.md")) {
    const text = "Latency readout uploaded through POST /api/documents during bridge e2e. p95 is 180ms.";
    const created = await api("POST", "/api/documents", {
      filename: "latency-readout.md",
      mediaType: "text/markdown",
      dataBase64: Buffer.from(text).toString("base64"),
      summarize: false,
    });
    if (created.status !== 201) throw new Error(`document upload failed: ${created.status} ${created.text}`);
    console.log("uploaded latency-readout.md through POST /api/documents");
  }
  const decisions = await api("GET", "/api/decisions?status=pending");
  const titles = list<{ title: string }>(decisions.json, "decisions").map((row) => row.title);
  if (!titles.some((title) => title.includes("echo ensemble-bridge-e2e"))) {
    const created = await api("POST", "/api/decisions", {
      source: "cursor",
      event: "beforeShellExecution",
      waitSeconds: 3600,
      payload: { command: "echo ensemble-bridge-e2e", cwd: "/workspace" },
    });
    if (created.status !== 202) throw new Error(`decision create failed: ${created.status} ${created.text}`);
    console.log("opened a Needs-me editor prompt through POST /api/decisions");
  }
}

async function snapshot(from: string, to: string): Promise<Snap> {
  const [tasks, people, projects, repos, skills, documents, approvals, decisions, calendar] = await Promise.all([
    api("GET", "/api/tasks"),
    api("GET", "/api/people"),
    api("GET", "/api/projects"),
    api("GET", "/api/repos"),
    api("GET", "/api/skills"),
    api("GET", "/api/documents"),
    api("GET", "/api/approvals"),
    api("GET", "/api/decisions?status=pending"),
    api("GET", `/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  ]);
  for (const [name, row] of [
    ["tasks", tasks],
    ["people", people],
    ["projects", projects],
    ["repos", repos],
    ["skills", skills],
    ["documents", documents],
    ["approvals", approvals],
    ["decisions", decisions],
    ["calendar", calendar],
  ] as const) {
    if (row.status !== 200) throw new Error(`snapshot ${name} returned ${row.status}: ${row.text.slice(0, 200)}`);
  }
  const projectRows = list<{ id: string; name: string }>(projects.json, "projects");
  const details = await Promise.all(projectRows.map((project) => api("GET", `/api/projects/${project.id}`)));
  const meetingNotes: Snap["meetingNotes"] = [];
  const upcomingDeliverables: Snap["upcomingDeliverables"] = [];
  const projectsFull: Snap["projects"] = [];
  for (const detail of details) {
    const project = asRecord(detail.json.project);
    const notes = Array.isArray(project.meetingNotes) ? project.meetingNotes : [];
    const deliverables = Array.isArray(project.deliverables) ? project.deliverables : [];
    projectsFull.push({
      id: String(project.id),
      name: String(project.name),
      deliverables: deliverables.map((row) => asRecord(row) as { id: string; title: string; status: string }),
    });
    for (const note of notes) {
      const row = asRecord(note);
      meetingNotes.push({ id: String(row.id), title: String(row.title) });
    }
    for (const item of deliverables) {
      const row = asRecord(item);
      if (row.status === "upcoming") upcomingDeliverables.push({ id: String(row.id), title: String(row.title) });
    }
  }
  return {
    tasks: list<{ id: string; title: string; status: string }>(tasks.json, "tasks"),
    people: list<{ id: string; name: string }>(people.json, "people"),
    projects: projectsFull,
    repos: list<{ id: string; fullName: string }>(repos.json, "repos"),
    skills: list<{ id: string; name: string; enabled?: boolean }>(skills.json, "skills").filter((skill) => skill.enabled !== false),
    documents: list<{ id: string; filename: string }>(documents.json, "documents"),
    approvals: list<{ id: string; title: string }>(approvals.json, "approvals"),
    decisions: list<{ id: string; title: string; status?: string }>(decisions.json, "decisions"),
    meetings: list<{ id: string; title: string }>(calendar.json, "events"),
    meetingNotes,
    upcomingDeliverables,
  };
}

function idsMatch(label: string, bridgeRows: Array<{ id?: string }>, dbRows: Array<{ id: string }>): { pass: boolean; sample: string } {
  const bridgeIds = new Set(bridgeRows.map((row) => String(row.id)));
  const dbIds = new Set(dbRows.map((row) => row.id));
  const missing = [...dbIds].filter((id) => !bridgeIds.has(id));
  const extra = [...bridgeIds].filter((id) => !dbIds.has(id));
  const pass = missing.length === 0 && extra.length === 0 && bridgeIds.size === dbIds.size;
  return {
    pass,
    sample: `${label}: bridge ${bridgeIds.size}, database ${dbIds.size}${missing.length ? `, missing ${missing.length}` : ""}${extra.length ? `, extra ${extra.length}` : ""}`,
  };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ error?: string; data: Record<string, unknown>; text: string }> {
  try {
    const result = await client.callTool({ name, arguments: args });
    return parseTool(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message, data: {}, text: message };
  }
}

async function readUri(client: Client, uri: string): Promise<{ error?: string; data: Record<string, unknown>; text: string }> {
  try {
    const result = await client.readResource({ uri });
    const contents = result.contents ?? [];
    const text = contents.map((item) => ("text" in item && typeof item.text === "string" ? item.text : "")).join("\n");
    try {
      return { data: asRecord(JSON.parse(text)), text };
    } catch {
      return { error: `resource was not JSON: ${text.slice(0, 160)}`, data: {}, text };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message, data: {}, text: message };
  }
}

function rows(data: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = data[key];
  return Array.isArray(value) ? value.map((item) => asRecord(item)) : [];
}

async function exercise(client: Client, transport: string, snap: Snap, from: string, to: string): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  const expected = [...TOOL_NAMES].sort();
  record(transport, "tools/list", names.join(",") === expected.join(","), names.join(", "));

  const resources = await client.listResources();
  const uris = resources.resources.map((resource) => resource.uri).sort();
  record(transport, "resources/list", FIXED_URIS.every((uri) => uris.includes(uri)) && uris.length === FIXED_URIS.length, uris.join(", "));

  const templates = await client.listResourceTemplates();
  const templateUris = templates.resourceTemplates.map((template) => template.uriTemplate);
  record(
    transport,
    "resource templates",
    TEMPLATE_URIS.every((uri) => templateUris.includes(uri)),
    templateUris.join(", "),
  );

  const tasks = await call(client, "ensemble_tasks", { limit: 50 });
  const taskRows = rows(tasks.data, "tasks");
  const taskCmp = idsMatch("tasks", taskRows, snap.tasks);
  const statuses = [...new Set(taskRows.map((row) => String(row.status)))].sort();
  const wanted = ["blocked", "done", "dropped", "in_progress", "proposed", "todo", "waiting_approval"];
  record(
    transport,
    "ensemble_tasks",
    !tasks.error && taskCmp.pass && wanted.every((status) => statuses.includes(status)),
    tasks.error ?? `${taskCmp.sample}; statuses ${statuses.join(",")}; first “${String(taskRows[0]?.title ?? "")}”`,
  );
  const todo = await call(client, "ensemble_tasks", { status: "todo", limit: 50 });
  const todoRows = rows(todo.data, "tasks");
  const dbTodo = snap.tasks.filter((task) => task.status === "todo");
  record(
    transport,
    "ensemble_tasks status=todo",
    !todo.error && idsMatch("todo", todoRows, dbTodo).pass && todoRows.every((row) => row.status === "todo"),
    todo.error ?? `todo ${todoRows.length}; first “${String(todoRows[0]?.title ?? "")}”`,
  );

  const people = await call(client, "ensemble_people", { limit: 50 });
  const peopleRows = rows(people.data, "people");
  const priya = peopleRows.find((row) => row.name === "Priya Nair");
  record(
    transport,
    "ensemble_people",
    !people.error && idsMatch("people", peopleRows, snap.people).pass && Boolean(priya),
    people.error ?? `count ${peopleRows.length}; ${String(priya?.name ?? "Priya missing")} (${String(priya?.role ?? "")})`,
  );
  if (priya?.id) ids.person = String(priya.id);

  const projects = await call(client, "ensemble_projects", { limit: 50 });
  const projectRows = rows(projects.data, "projects");
  record(
    transport,
    "ensemble_projects",
    !projects.error && idsMatch("projects", projectRows, snap.projects).pass && projectRows.some((row) => row.name === "Ensemble Hub"),
    projects.error ?? projectRows.map((row) => String(row.name)).join(", "),
  );
  const hubProject = projectRows.find((row) => row.name === "Ensemble Hub");
  if (hubProject?.id) ids.project = String(hubProject.id);

  const repos = await call(client, "ensemble_repos", { query: "httpx", limit: 50 });
  const repoRows = rows(repos.data, "repos");
  const httpx = repoRows.find((row) => row.fullName === "encode/httpx");
  const allRepos = await call(client, "ensemble_repos", { limit: 50 });
  const allRepoRows = rows(allRepos.data, "repos");
  record(
    transport,
    "ensemble_repos",
    !allRepos.error && idsMatch("repos", allRepoRows, snap.repos).pass && Boolean(httpx),
    allRepos.error ?? `count ${allRepoRows.length}; query httpx → ${String(httpx?.fullName ?? "missing")}`,
  );
  if (httpx?.id) ids.repo = String(httpx.id);

  const skills = await call(client, "ensemble_skills", { limit: 50 });
  const skillRows = rows(skills.data, "skills");
  const emailTone = skillRows.find((row) => row.name === "Email tone");
  record(
    transport,
    "ensemble_skills",
    !skills.error && idsMatch("skills", skillRows, snap.skills).pass && emailTone?.trust === "trusted",
    skills.error ?? `${skillRows.length} skills; “${String(emailTone?.name ?? "")}” trust=${String(emailTone?.trust ?? "")}`,
  );
  if (emailTone?.id) ids.skill = String(emailTone.id);

  const deliverables = await call(client, "ensemble_deliverables", { limit: 50 });
  const deliverableRows = rows(deliverables.data, "deliverables");
  record(
    transport,
    "ensemble_deliverables",
    !deliverables.error &&
      idsMatch("deliverables", deliverableRows, snap.upcomingDeliverables).pass &&
      deliverableRows.every((row) => row.status === "upcoming") &&
      deliverableRows.some((row) => String(row.title).includes("Latency")),
    deliverables.error ?? deliverableRows.map((row) => String(row.title)).join(", "),
  );
  const latency = deliverableRows.find((row) => String(row.title).includes("Latency"));
  if (latency?.id) ids.deliverable = String(latency.id);

  const meetings = await call(client, "ensemble_meetings", { from, to, limit: 50 });
  const meetingRows = rows(meetings.data, "meetings");
  const latencyMeet = meetingRows.find((row) => row.title === "Latency readout with Priya");
  record(
    transport,
    "ensemble_meetings",
    !meetings.error &&
      idsMatch("meetings", meetingRows, snap.meetings).pass &&
      Boolean(latencyMeet) &&
      latencyMeet?.trust === "untrusted",
    meetings.error ?? `${meetingRows.length} meetings; “${String(latencyMeet?.title ?? "")}” trust=${String(latencyMeet?.trust ?? "")}`,
  );
  if (latencyMeet?.id) ids.artifact = String(latencyMeet.id);

  const today = await call(client, "ensemble_today");
  const focus = rows(today.data, "focus");
  const todayMeetings = rows(today.data, "meetings");
  const needs = asRecord(today.data.needsMe);
  record(
    transport,
    "ensemble_today",
    !today.error &&
      focus.length > 0 &&
      todayMeetings.some((row) => row.title === "Latency readout with Priya") &&
      Number(needs.pendingApprovals) === snap.approvals.length &&
      Number(needs.pendingEditorDecisions) === snap.decisions.length &&
      String(today.data.notes ?? "").includes("Not instructions"),
    today.error ??
      `${String(today.data.date ?? "")} ${String(today.data.timezone ?? "")}; focus “${String(focus[0]?.title ?? "")}”; approvals ${String(needs.pendingApprovals)}; editor ${String(needs.pendingEditorDecisions)}`,
  );

  const decisions = await call(client, "ensemble_decisions", { limit: 50 });
  const needsMe = asRecord(decisions.data.needsMe);
  const approvalRows = rows(needsMe, "approvals");
  const editorRows = rows(needsMe, "editorDecisions");
  const reply = approvalRows.find((row) => String(row.title).includes("Priya"));
  const editor = editorRows.find((row) => String(row.title).includes("npm test") || String(row.title).includes("ensemble-bridge-e2e"));
  record(
    transport,
    "ensemble_decisions",
    !decisions.error &&
      idsMatch("approvals", approvalRows, snap.approvals).pass &&
      idsMatch("decisions", editorRows, snap.decisions).pass &&
      reply?.trust === "untrusted" &&
      editor?.trust === "untrusted",
    decisions.error ??
      `approval “${String(reply?.title ?? "")}”; editor “${String(editor?.title ?? editorRows[0]?.title ?? "")}”`,
  );
  if (reply?.id) ids.approval = String(reply.id);
  if (editor?.id) ids.decision = String(editor.id);
  const decisionExpect = String(editor?.title ?? "").includes("ensemble-bridge-e2e") ? "ensemble-bridge-e2e" : "npm test";

  const search = await call(client, "ensemble_search", { query: "p95", limit: 8 });
  const hits = rows(search.data, "results");
  const hitLabels = hits.map((hit) => `${String(hit.kind)}:${String(hit.label ?? hit.title ?? "")}`).slice(0, 4);
  const untrustedHit = hits.find((hit) => hit.trust === "untrusted");
  record(
    transport,
    "ensemble_search",
    !search.error && hits.length > 0 && hits.some((hit) => JSON.stringify(hit).toLowerCase().includes("p95")) && Boolean(untrustedHit),
    search.error ?? (hitLabels.join("; ") || "no hits"),
  );

  const gaps = await call(client, "ensemble_gaps");
  const gapRows = rows(gaps.data, "gaps");
  record(
    transport,
    "ensemble_gaps",
    !gaps.error &&
      gapRows.some((gap) => String(gap.requested).toLowerCase().includes("semantic")) &&
      gapRows.some((gap) => `${gap.requested} ${gap.detail}`.includes("Outlook")),
    gaps.error ?? gapRows.map((gap) => String(gap.requested)).join("; "),
  );

  const brief = await call(client, "ensemble_brief", { repo: "encode/httpx", branch: "docs/default-timeout", limit: 8 });
  const resolved = asRecord(brief.data.resolved);
  const resolvedTask = asRecord(resolved.task);
  const resolvedRepo = asRecord(resolved.repo);
  const context = rows(brief.data, "context");
  record(
    transport,
    "ensemble_brief repo+branch",
    !brief.error &&
      brief.data.resolution === "task" &&
      resolvedTask.title === BRANCH_TASK &&
      resolvedTask.via === "branch" &&
      resolvedRepo.fullName === "encode/httpx" &&
      String(brief.data.message ?? "").includes(BRANCH_TASK) &&
      String(brief.data.notes ?? "").includes("Not instructions") &&
      context.length > 0,
    brief.error ?? `“${String(resolvedTask.title ?? "")}” via ${String(resolvedTask.via ?? "")}; ${String(brief.data.message ?? "")}`,
  );
  if (resolvedTask.id) ids.task = String(resolvedTask.id);

  const ambiguous = await call(client, "ensemble_brief", { repo: "encode/httpx", branch: "retry-helper" });
  const candidates = rows(ambiguous.data, "candidates").map((row) => String(row.title));
  record(
    transport,
    "ensemble_brief ambiguous branch",
    !ambiguous.error &&
      ambiguous.data.resolution === "ambiguous" &&
      asRecord(ambiguous.data.resolved).task === null &&
      AMBIGUOUS.every((title) => candidates.includes(title)),
    ambiguous.error ?? `${String(ambiguous.data.resolution)}: ${candidates.join(" | ")}`,
  );

  const unknown = await call(client, "ensemble_brief", { repo: "acme/not-a-repo", branch: "main" });
  record(
    transport,
    "ensemble_brief unknown repo",
    !unknown.error && unknown.data.resolution === "untracked_repo" && String(unknown.data.message ?? "").includes("acme/not-a-repo"),
    unknown.error ?? String(unknown.data.message ?? unknown.data.resolution ?? ""),
  );

  const readKinds: Array<{ kind: string; id?: string; expect: string }> = [
    { kind: "task", id: ids.task, expect: BRANCH_TASK },
    { kind: "project", id: ids.project, expect: "Ensemble Hub" },
    { kind: "repo", id: ids.repo, expect: "encode/httpx" },
    { kind: "skill", id: ids.skill, expect: "Email tone" },
    { kind: "deliverable", id: ids.deliverable, expect: "Latency" },
    { kind: "person", id: ids.person, expect: "Priya Nair" },
    { kind: "approval", id: ids.approval, expect: "Priya" },
    { kind: "decision", id: ids.decision, expect: decisionExpect },
  ];
  for (const item of readKinds) {
    if (!item.id) {
      record(transport, `ensemble_read ${item.kind}`, false, "no id from the list tools");
      continue;
    }
    const read = await call(client, "ensemble_read", { kind: item.kind, id: item.id });
    const blob = JSON.stringify(read.data);
    record(transport, `ensemble_read ${item.kind}`, !read.error && blob.includes(item.expect), read.error ?? blob.slice(0, 220));
  }

  const emailSearch = await call(client, "ensemble_search", { query: "Leadership is asking", limit: 5 });
  const email = rows(emailSearch.data, "results").find((hit) => hit.artifactKind === "email" || String(hit.label).includes("ranker latency"));
  if (email?.id) {
    const read = await call(client, "ensemble_read", { kind: "artifact", id: String(email.id) });
    record(
      transport,
      "ensemble_read artifact",
      !read.error && read.data.trust === "untrusted" && String(read.data.title ?? read.data.artifactKind ?? "").length > 0,
      read.error ?? `${String(read.data.artifactKind)} “${String(read.data.title)}” trust=${String(read.data.trust)}`,
    );
    ids.email = String(email.id);
  } else {
    record(transport, "ensemble_read artifact", false, "search did not find the seeded Priya email");
  }

  const fileDoc = snap.documents.find((doc) => doc.filename === "seed-ranker-notes.md") ?? snap.documents[0];
  if (fileDoc) {
    const read = await call(client, "ensemble_read", { kind: "document", id: fileDoc.id });
    record(
      transport,
      "ensemble_read document",
      !read.error && read.data.filename === fileDoc.filename && JSON.stringify(read.data).includes("p95"),
      read.error ?? `file “${String(read.data.filename)}”`,
    );
    ids.document = fileDoc.id;
  } else {
    record(transport, "ensemble_read document", false, "no document in the database");
  }

  const note = snap.meetingNotes.find((row) => row.title === "Ranker design review") ?? snap.meetingNotes[0];
  if (note) {
    const read = await call(client, "ensemble_read", { kind: "meeting_note", id: note.id });
    record(
      transport,
      "ensemble_read meeting_note",
      !read.error && String(read.data.title) === note.title,
      read.error ?? `“${String(read.data.title)}” trust=${String(read.data.trust)}`,
    );
    ids.meeting_note = note.id;
  } else {
    record(transport, "ensemble_read meeting_note", false, "no meeting note in the database");
  }

  for (const uri of FIXED_URIS) {
    const read = await readUri(client, uri);
    const keys = Object.keys(read.data).slice(0, 6).join(",");
    record(transport, `resource ${uri}`, !read.error && keys.length > 0, read.error ?? keys);
  }

  const templateReads: Array<[string, string | undefined]> = [
    ["ensemble://tasks/", ids.task],
    ["ensemble://projects/", ids.project],
    ["ensemble://repos/", ids.repo],
    ["ensemble://skills/", ids.skill],
    ["ensemble://people/", ids.person],
  ];
  for (const [prefix, id] of templateReads) {
    if (!id) {
      record(transport, `template ${prefix}{id}`, false, "missing id");
      continue;
    }
    const read = await readUri(client, `${prefix}${id}`);
    record(transport, `template ${prefix}{id}`, !read.error && JSON.stringify(read.data).includes(id), read.error ?? `id ${id}`);
  }
  const itemReads: Array<[string, string | undefined]> = [
    ["task", ids.task],
    ["project", ids.project],
    ["repo", ids.repo],
    ["skill", ids.skill],
    ["deliverable", ids.deliverable],
    ["person", ids.person],
    ["artifact", ids.email || ids.artifact],
    ["document", ids.document],
    ["meeting_note", ids.meeting_note],
    ["approval", ids.approval],
    ["decision", ids.decision],
  ];
  for (const [kind, id] of itemReads) {
    if (!id) {
      record(transport, `template ensemble://items/${kind}/{id}`, false, "missing id");
      continue;
    }
    const read = await readUri(client, `ensemble://items/${kind}/${id}`);
    record(transport, `template ensemble://items/${kind}/{id}`, !read.error && JSON.stringify(read.data).includes(id), read.error ?? `id ${id}`);
  }

  return ids;
}

function listeners(port: number): string {
  const result = spawnSync("ss", ["-ltn"], { encoding: "utf8" });
  const lines = (result.stdout || "").split("\n").filter((line) => line.includes(`:${port}`));
  return lines.join(" | ") || "(no listener)";
}

function tcpOpen(host: string, port: number, ms = 1200): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(ms);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Local address column from `ss -ltn`, e.g. `127.0.0.1:5432`. Ignores the peer column (`0.0.0.0:*`). */
function localBinds(port: number): string[] {
  return listeners(port)
    .split(" | ")
    .map((line) => line.trim().split(/\s+/)[3] ?? "")
    .filter((address) => address.endsWith(`:${port}`) || address.endsWith(`]:${port}`));
}

function lanAddresses(): string[] {
  const ips = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      const family = entry.family as string | number;
      if (entry.internal || (family !== "IPv4" && family !== 4)) continue;
      ips.add(entry.address);
    }
  }
  // os.networkInterfaces() skips bridges with no carrier (docker0 is UP but DOWN/NO-CARRIER).
  // Those addresses still accept local TCP, so a 0.0.0.0 publish would be reachable there.
  if (process.platform === "linux") {
    const listed = spawnSync("ip", ["-4", "-o", "addr", "show"], { encoding: "utf8" });
    for (const match of (listed.stdout ?? "").matchAll(/\binet (\d+\.\d+\.\d+\.\d+)\//g)) {
      const address = match[1] ?? "";
      if (address && !address.startsWith("127.")) ips.add(address);
    }
  }
  return [...ips];
}

async function security(token: string, snap: Snap): Promise<void> {
  const auth = { authorization: `Bearer ${token}` };
  const taskId = snap.tasks[0]?.id;
  const docId = snap.documents[0]?.id;
  const personId = snap.people[0]?.id;
  const beforeTasks = snap.tasks.length;
  const beforeTokens = list<{ id: string }>((await api("GET", "/api/connect/bridge")).json, "tokens").length;

  const writes: Array<[string, string, unknown]> = [
    ["POST", "/api/tasks", { title: "bridge-e2e must not create this" }],
    ["PATCH", `/api/tasks/${taskId}`, { title: "bridge-e2e must not rename this" }],
    ["PUT", `/api/tasks/${taskId}/page`, { content: null }],
    ["DELETE", `/api/documents/${docId}`, undefined],
    ["POST", "/api/people", { name: "Bridge Should Not Create" }],
    ["DELETE", `/api/people/${personId}`, undefined],
    ["POST", "/api/connect/token", { name: "should-not-mint" }],
  ];
  for (const [method, path, body] of writes) {
    const response = await api(method, path, body, auth);
    const message = String(response.json.error ?? response.text).slice(0, 180);
    record("security", `${method} ${path.split("?")[0]} with bridge token`, response.status === 403 && /read-only/i.test(message), `HTTP ${response.status}: ${message}`);
  }
  const afterTasks = list<{ id: string; title: string }>((await api("GET", "/api/tasks")).json, "tasks");
  const afterTokens = list<{ id: string }>((await api("GET", "/api/connect/bridge")).json, "tokens");
  const taskUntouched = afterTasks.length === beforeTasks && afterTasks.some((task) => task.title === BRANCH_TASK);
  record("security", "writes did not change tasks or mint a token", taskUntouched && afterTokens.length === beforeTokens, `tasks ${beforeTasks}→${afterTasks.length}; tokens ${beforeTokens}→${afterTokens.length}`);

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await api(method, "/api/bridge/tasks", { title: "nope" }, auth);
    const message = String(response.json.error ?? response.text).slice(0, 180);
    record("security", `${method} /api/bridge/tasks`, response.status === 405 && /read-only/i.test(message), `HTTP ${response.status}: ${message}`);
  }

  const bridgeGet = await api("GET", "/api/tasks", undefined, auth);
  record("security", "GET /api/tasks with bridge token", bridgeGet.status === 403, `HTTP ${bridgeGet.status}: ${String(bridgeGet.json.error ?? "").slice(0, 160)}`);

  const bridgeRead = await api("GET", "/api/bridge/tasks?limit=1", undefined, auth);
  record("security", "GET /api/bridge/tasks with bridge token", bridgeRead.status === 200, `HTTP ${bridgeRead.status}`);

  const bypass = await api("GET", "/api/bridge/tasks");
  const bypassOk = await api("GET", "/api/tasks");
  record(
    "security",
    "ENSEMBLE_DEV_AUTH_BYPASS rejected on /api/bridge",
    bypass.status === 401 && /ENSEMBLE_DEV_AUTH_BYPASS/.test(String(bypass.json.error ?? "")) && bypassOk.status === 200,
    `bridge HTTP ${bypass.status}: ${String(bypass.json.error ?? "").slice(0, 160)}; /api/tasks HTTP ${bypassOk.status}`,
  );

  const internal = await api("GET", "/api/bridge/gaps", undefined, { "x-ensemble-internal": "dev-internal-token", "x-ensemble-user": "local" });
  record(
    "security",
    "dev-internal-token rejected on /api/bridge",
    internal.status === 401 && /dev-internal-token/.test(String(internal.json.error ?? "")),
    `HTTP ${internal.status}: ${String(internal.json.error ?? "").slice(0, 180)}`,
  );

  const hubBind = listeners(4000);
  const bridgeBind = listeners(4010);
  const hubLoopback = /127\.0\.0\.1:4000|\[::1\]:4000/.test(hubBind) && !/0\.0\.0\.0:4000|\*:4000/.test(hubBind);
  const bridgeLoopback = /127\.0\.0\.1:4010|\[::1\]:4010/.test(bridgeBind) && !/0\.0\.0\.0:4010|\*:4010/.test(bridgeBind);
  record("security", "hub-api binds only to loopback", hubLoopback, hubBind);
  record("security", "HTTP bridge binds only to loopback", bridgeLoopback, bridgeBind);

  for (const ip of lanAddresses()) {
    let reachable = false;
    let detail = "connection failed";
    try {
      const response = await fetch(`http://${ip}:4000/health`, { signal: AbortSignal.timeout(1500) });
      reachable = response.ok;
      detail = `HTTP ${response.status}`;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    record("security", `hub-api not reachable on ${ip}:4000`, !reachable, detail);
  }

  for (const [name, port] of [
    ["postgres", 5432],
    ["redis", 6379],
  ] as const) {
    const binds = localBinds(port);
    const loopback = binds.length > 0 && binds.every((address) => address.startsWith("127.0.0.1:") || address.startsWith("[::1]:"));
    record("security", `${name} binds only to loopback`, loopback, binds.join(", ") || listeners(port));
    const local = await tcpOpen("127.0.0.1", port);
    record("security", `${name} accepts 127.0.0.1`, local, `127.0.0.1 ${local ? "open" : "closed"}`);
    const ips = lanAddresses();
    if (ips.length === 0) {
      record("security", `${name} has a non-loopback address to probe`, false, "no non-loopback IPv4 address on this machine");
    }
    for (const ip of ips) {
      const open = await tcpOpen(ip, port);
      record("security", `${name} not reachable on ${ip}:${port}`, !open, open ? "tcp connect succeeded" : "connection refused or timed out");
    }
  }

  const refused = spawn(process.execPath, [dist, "--http"], {
    env: { ...getDefaultEnvironment(), CONTEXT_BRIDGE_HOST: "0.0.0.0", CONTEXT_BRIDGE_PORT: "4011", ENSEMBLE_BRIDGE_TOKEN: token, HUB_API_URL: hub },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let refusedErr = "";
  refused.stderr?.on("data", (chunk) => {
    refusedErr += String(chunk);
  });
  const refusedCode = await new Promise<number>((resolvePromise) => {
    const timer = setTimeout(() => {
      refused.kill("SIGKILL");
      resolvePromise(124);
    }, 5000);
    refused.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise(code ?? 1);
    });
  });
  record(
    "security",
    "HTTP bridge refuses non-loopback host",
    refusedCode !== 0 && /loopback/i.test(refusedErr),
    `exit ${refusedCode}: ${refusedErr.trim().slice(0, 220)}`,
  );

  const missing = await connectStdio({ HUB_API_URL: hub });
  try {
    const result = await call(missing.client, "ensemble_today");
    record(
      "security",
      "missing token",
      Boolean(result.error) && /ENSEMBLE_BRIDGE_TOKEN/.test(result.error ?? "") && !/at |\n\s+at /.test(result.error ?? ""),
      (result.error ?? result.text).slice(0, 240),
    );
  } finally {
    await missing.close();
  }

  const invalid = await connectStdio({ HUB_API_URL: hub, ENSEMBLE_BRIDGE_TOKEN: "ens_not-a-real-bridge-token" });
  try {
    const result = await call(invalid.client, "ensemble_today");
    record(
      "security",
      "invalid token",
      Boolean(result.error) && /sign in/i.test(result.error ?? "") && !result.error?.includes("    at "),
      (result.error ?? result.text).slice(0, 240),
    );
  } finally {
    await invalid.close();
  }

  const malformed = await connectStdio({ HUB_API_URL: hub, ENSEMBLE_BRIDGE_TOKEN: "not-an-ens-token" });
  try {
    const result = await call(malformed.client, "ensemble_gaps");
    record(
      "security",
      "token that does not start with ens_",
      Boolean(result.error) && /ens_/.test(result.error ?? ""),
      (result.error ?? result.text).slice(0, 240),
    );
  } finally {
    await malformed.close();
  }

  const down = await connectStdio({ HUB_API_URL: "http://127.0.0.1:9", ENSEMBLE_BRIDGE_TOKEN: token });
  try {
    const result = await call(down.client, "ensemble_brief", { repo: "encode/httpx", branch: "docs/default-timeout" });
    record(
      "security",
      "hub-api down",
      Boolean(result.error) && (result.error ?? "").includes("Ensemble is not running. Start it with `pnpm dev`."),
      (result.error ?? result.text).slice(0, 240),
    );
  } finally {
    await down.close();
  }
}

function writeReport(envNotes: string[]): void {
  const failed = checks.filter((check) => !check.pass);
  const report = {
    ranAt: new Date().toISOString(),
    pass: failed.length === 0,
    passed: checks.length - failed.length,
    failed: failed.length,
    friction: [...friction, ...envNotes],
    checks,
  };
  const json = JSON.stringify(report, null, 2);
  writeFileSync(resolve(root, "bridge-e2e-report.json"), json);
  if (existsSync("/opt/cursor/artifacts")) writeFileSync("/opt/cursor/artifacts/bridge-e2e-report.json", json);
  console.log(`\n${report.pass ? "PASS" : "FAIL"}  ${report.passed} passed, ${report.failed} failed`);
  if (failed.length) {
    console.log("Failed checks:");
    for (const check of failed) console.log(`  - [${check.group}] ${check.name}: ${check.sample}`);
  }
}

async function main(): Promise<void> {
  mkdirSync(logDir, { recursive: true });
  const env = ensureEnvFile();
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, ENSEMBLE_DEV_AUTH_BYPASS: "true", HUB_API_HOST: "127.0.0.1" };
  delete childEnv.ENSEMBLE_INTERNAL_TOKEN;

  console.log("— infra —");
  const info = spawnSync("docker", ["info"], { stdio: "ignore" });
  if (info.status !== 0) {
    const sudoInfo = spawnSync("sudo", ["docker", "info"], { stdio: "ignore" });
    if (sudoInfo.status !== 0) {
      friction.push("Docker daemon was not running. Started dockerd manually because this environment has no systemd.");
      const dockerd = spawn("sudo", ["dockerd"], { detached: true, stdio: "ignore" });
      dockerd.unref();
      for (let i = 0; i < 30; i += 1) {
        if (spawnSync("sudo", ["docker", "info"], { stdio: "ignore" }).status === 0) break;
        await sleep(500);
      }
    }
  }
  await docker(["volume", "create", "ensemble_pg"], childEnv);
  await docker(["compose", "-f", "infra/docker-compose.yml", "up", "-d"], childEnv);
  for (let i = 0; i < 30; i += 1) {
    const ready = spawnSync("sudo", ["docker", "exec", "ensemble-postgres", "pg_isready", "-U", "ensemble", "-d", "ensemble"], { stdio: "ignore" });
    if (ready.status === 0) break;
    await sleep(500);
  }

  console.log("— database —");
  await run("pnpm", ["db:generate"], childEnv);
  await run("pnpm", ["db:push", "--", "--accept-data-loss"], childEnv);
  await run("pnpm", ["db:seed"], childEnv);
  await run("pnpm", ["bridge:build"], childEnv);

  console.log("— hub-api —");
  await freePort(4000);
  spawnBackground(
    "hub-api",
    "pnpm",
    ["--filter", "@ensemble/hub-api", "exec", "tsx", "src/index.ts"],
    childEnv,
    root,
  );
  await waitForHttp(`${hub}/health`);
  const health = await api("GET", "/health");
  if (health.json.service !== "hub-api") throw new Error(`unexpected health: ${health.text}`);

  await ensureApiFixtures();
  const minted = await api("POST", "/api/connect/token", { name: "bridge-e2e" });
  const token = String(minted.json.token ?? "");
  if (minted.status !== 200 || !token.startsWith("ens_")) {
    throw new Error(`token mint failed: ${minted.status} ${minted.text.slice(0, 200)}`);
  }
  console.log(`minted bridge token ${token.slice(0, 8)}… (value not logged)`);
  writeFileSync(resolve(logDir, "token"), token, { mode: 0o600 });

  const from = new Date(Date.now() - 60_000).toISOString();
  const to = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const snap = await snapshot(from, to);
  console.log(
    `database: ${snap.tasks.length} tasks, ${snap.people.length} people, ${snap.projects.length} projects, ${snap.repos.length} repos, ${snap.skills.length} skills, ${snap.upcomingDeliverables.length} deliverables, ${snap.meetings.length} meetings, ${snap.documents.length} documents, ${snap.approvals.length} approvals, ${snap.decisions.length} decisions, ${snap.meetingNotes.length} notes`,
  );

  console.log("— stdio —");
  const stdio = await connectStdio({ HUB_API_URL: hub, ENSEMBLE_BRIDGE_TOKEN: token });
  try {
    await exercise(stdio.client, "stdio", snap, from, to);
  } finally {
    await stdio.close();
  }

  console.log("— streamable http —");
  await freePort(4010);
  spawnBackground(
    "bridge-http",
    process.execPath,
    [dist, "--http"],
    { ...childEnv, HUB_API_URL: hub, ENSEMBLE_BRIDGE_TOKEN: token, CONTEXT_BRIDGE_HOST: "127.0.0.1", CONTEXT_BRIDGE_PORT: "4010" },
    root,
  );
  await waitForHttp("http://127.0.0.1:4010/health");
  const httpClient = new Client({ name: "ensemble-bridge-live-e2e-http", version: "0.0.0" });
  const httpTransport = new StreamableHTTPClientTransport(new URL(bridgeHttp));
  await httpClient.connect(httpTransport);
  try {
    await exercise(httpClient, "http", snap, from, to);
  } finally {
    await httpClient.close();
  }

  console.log("— security —");
  await security(token, snap);

  writeReport([]);
  if (checks.some((check) => !check.pass)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  writeReport([`run aborted: ${message.split("\n")[0]}`]);
  process.exit(1);
});
