/**
 * The live evaluation (docs/35 §11): the owner's own requests from real conversations, given to a node
 * on each model under test, against a local hub-api and a REAL computer: this checkout's Ensemble
 * runtime (the CLI's sidecar), started here in a data folder of its own, paired to the hub. The node
 * browses the real web from this machine, takes real screenshots and saves real files. Each case is
 * checked (the tools used, the screenshots with the reply, a table, a file in Ensemble Files, no request
 * for a password in the chat), and every picture is saved to NODE_EVAL_OUT for a person to look at.
 * Not a CI gate: it spends included credits and needs the internet and Chromium.
 *
 *   HUB_API=http://127.0.0.1:4098 node apps/hub-api/scripts/node-live-eval.mjs
 *   NODE_EVAL_MODELS=gpt-6-luna:low  NODE_EVAL_CASES=1,2  NODE_EVAL_OUT=/tmp/node-live
 *
 * Run it from a server started with ENSEMBLE_INPROCESS_RUNTIME=1 and the included models configured. A
 * computer card the node raises is answered "Always for this folder"; a sign-in card is left waiting
 * and declined at the end of its case (no one types passwords here).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.HUB_API ?? "http://127.0.0.1:4098";
const MODELS = (process.env.NODE_EVAL_MODELS ?? "gpt-6-luna:low").split(",").map((pair) => {
  const [model, effort] = pair.split(":");
  return { model, effort };
});
const ONLY = process.env.NODE_EVAL_CASES ? new Set(process.env.NODE_EVAL_CASES.split(",").map(Number)) : null;
const OUT = process.env.NODE_EVAL_OUT ?? join(tmpdir(), `node-live-${Date.now().toString(36)}`);
const HUB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = Date.now().toString(36);

/** The owner's requests, as they wrote them (31 October), and what a good answer has. */
const CASES = [
  {
    ask: "can you search and compare PS5 pricing across 4/5 different shopping website, I want to order it in USA: Wisconsin. Maybe search at Amazon and similar top 4/5 website ? send me screenshot of each website and a separate table in the chat of price comparision",
    tools: [["browser_shop", "browser_view", "browser_open"]],
    media: 4,
    table: true,
    says: /wisconsin|\bWI\b|537\d\d|madison|milwaukee/i,
    look: "An online store's page (search results or a product) for a PlayStation 5, readable, showing at least one price in US dollars. If it is Amazon, the delivery location near the top is in Wisconsin (a city or ZIP there), not India. A page that is only a robot/human check fails.",
  },
  { ask: "can you show me screenshot of google stock plot from web", tools: [["browser_view", "browser_screenshot"]], media: 1, look: "A stock price chart (a line or area plot over time) for Google/Alphabet (GOOG or GOOGL) is clearly visible, not cut off and not hidden behind an ad or banner." },
  { ask: "now get me 4 screenshots of the stock charts: microsoft, amazon, nvidia, apple", tools: [["browser_view", "browser_screenshot"]], media: 4, look: "A stock price chart for one of Microsoft, Amazon, NVIDIA or Apple is clearly visible." },
  {
    ask: "can you fetch this paper and add it to my files over ensemble ? BMD-45K Dataset paper from CVPR -- use official CVF or CVPR paper not from arxiv or any where...",
    tools: [["hub_save_file"]],
    file: /\.pdf$/i,
  },
  { ask: "can you run htop on my computer's terminal and send screenshot ?", tools: [["computer_terminal_screenshot"]], media: 1, look: "A terminal showing htop (CPU bars, memory, a process list)." },
  { ask: "what is the current price of a Nintendo Switch 2 at Best Buy and Target in the US? short answer with links", tools: [["browser_shop", "hub_web_search", "browser_view", "browser_extract"]], says: /\$\d/ },
  { ask: "can you login in my azure console and browse it to see my last day resource usage ?", tools: [["browser_login_needed", "web_task"]], card: "login" },
];

/**
 * A model that reads pictures grades each screenshot against what was asked (Azure Foundry, the same
 * included models; AZURE_FOUNDRY_RESOURCE and AZURE_FOUNDRY_API_KEY from the environment). Null when it
 * cannot judge.
 */
async function lookAt(path, expectation) {
  const resource = process.env.AZURE_FOUNDRY_RESOURCE;
  const key = process.env.AZURE_FOUNDRY_API_KEY;
  if (!resource || !key || !/\.(png|jpe?g|webp)$/i.test(path)) return null;
  const image = readFileSync(path).toString("base64");
  const mime = /\.png$/i.test(path) ? "image/png" : "image/jpeg";
  const response = await fetch(`https://${resource}.openai.azure.com/openai/v1/responses`, {
    method: "POST",
    headers: { "api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.NODE_EVAL_JUDGE ?? "gpt-6-luna",
      max_output_tokens: 400,
      input: [{ role: "user", content: [{ type: "input_text", text: `Grade this screenshot strictly. Expected: ${expectation}\nAnswer with JSON only: {"pass": true|false, "why": "one short sentence on what the picture shows"}` }, { type: "input_image", image_url: `data:${mime};base64,${image}` }] }],
    }),
  }).catch(() => null);
  if (!response?.ok) return null;
  const data = await response.json();
  const text = (data.output ?? []).flatMap((item) => item.content ?? []).map((part) => part.text ?? "").join("");
  try {
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
}

/** What the owner should never read from a node. */
const CHATTER = /\b(please (approve|allow)|approve (it|the request|this) in|needs me|send me your password|share your password|(type|tell|give) me (your )?(the )?(password|one[- ]time code|2fa code))\b/i;

async function call(path, { method = "GET", cookie, token, body, base = API, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return response;
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`);
  return parsed;
}

/** This checkout's runtime, in a data folder of its own (never the person's real one), on a free port. */
async function bootComputer() {
  const root = mkdtempSync(join(tmpdir(), "node-live-computer-"));
  const token = randomBytes(24).toString("base64url");
  const discovery = join(root, "api.json");
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.HUB_API_PORT;
  const child = spawn(process.execPath, ["--import", "tsx", "src/desktop/main.ts"], {
    cwd: HUB_DIR,
    env: {
      ...env,
      NODE_ENV: "development",
      ENSEMBLE_DATA_DIR: join(root, "pglite"),
      ENSEMBLE_BACKUP_DIR: join(root, "backups"),
      ENSEMBLE_DISCOVERY_FILE: discovery,
      ENSEMBLE_DESKTOP_TOKEN: token,
      ENSEMBLE_WORKSPACE_ROOT: join(root, "workspace"),
      ENSEMBLE_INPROCESS_RUNTIME: "1",
      ENSEMBLE_RUNTIME_OWNER: "cli",
      REDIS_URL: "memory://desktop",
      HUB_API_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => (logs = (logs + chunk.toString()).slice(-200_000)));
  child.stderr.on("data", (chunk) => (logs = (logs + chunk.toString()).slice(-200_000)));
  const started = Date.now();
  while (!existsSync(discovery)) {
    if (child.exitCode !== null) throw new Error(`the computer's runtime stopped:\n${logs.slice(-3000)}`);
    if (Date.now() - started > 180_000) throw new Error(`the computer's runtime did not start:\n${logs.slice(-3000)}`);
    await sleep(300);
  }
  const { port } = JSON.parse(readFileSync(discovery, "utf8"));
  const base = `http://127.0.0.1:${port}`;
  return {
    root,
    logs: () => logs,
    api: (path, init = {}) => call(path, { ...init, base, token }),
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(15_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

async function signup(label) {
  const response = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `node-live-${label}-${stamp}@ensemble.test`, password: `node-live-pass-${stamp}`, name: "Akash" }),
  });
  if (!response.ok) throw new Error(`sign-up ${response.status}: ${await response.text()}`);
  const pair = (response.headers.getSetCookie?.() ?? []).join(",").match(/(ensemble_(?:[a-z0-9_]+_)?session)=([^;]+)/);
  if (!pair) throw new Error("signing up did not set a session");
  return `${pair[1]}=${pair[2]}`;
}

async function pairComputer(cookie, computer) {
  const { code } = await call("/api/devices/pair", { method: "POST", cookie, body: {} });
  await computer.api("/api/remote/pair", { method: "POST", body: { apiBase: API, code, name: "Live eval computer" } });
  await computer.api("/api/remote", { method: "PUT", body: { enabled: true, acceptWebApprovals: true } });
  for (let i = 0; i < 90; i += 1) {
    const activity = await call("/api/node/activity", { cookie }).catch(() => null);
    const online = (activity?.computers ?? []).find((row) => row.online);
    if (online) return online;
    await sleep(2000);
  }
  throw new Error(`the computer did not come online:\n${computer.logs().slice(-3000)}`);
}

async function messages(cookie, roomId) {
  return (await call(`/api/node/rooms/${roomId}/messages`, { cookie })).messages;
}

/** Answers what the node asks for on cards the way a person in a hurry would: computer access yes; sign-ins left waiting. */
async function answerCards(cookie, rows, answered) {
  for (const card of rows.filter((row) => row.kind === "approval" && row.data?.status === "pending" && !answered.has(row.id))) {
    answered.add(card.id);
    if (card.data?.type === "computer" && card.data.decisionId) {
      const option = (card.data.options ?? []).find((label) => /^Always/.test(label)) ?? "Once";
      await call(`/api/decisions/${card.data.decisionId}/decide`, { method: "POST", cookie, body: { decision: "allow", scope: "once", reason: option } }).catch(() => undefined);
    }
  }
}

async function runCase(cookie, room, node, item, index) {
  const before = new Set((await messages(cookie, room.id)).map((row) => row.id));
  const started = Date.now();
  await call(`/api/node/rooms/${room.id}/messages`, { method: "POST", cookie, body: { body: item.ask } });
  const answered = new Set();
  let fresh = [];
  let quiet = 0;
  while (Date.now() - started < 420_000) {
    await sleep(4000);
    fresh = (await messages(cookie, room.id)).filter((row) => !before.has(row.id));
    await answerCards(cookie, fresh, answered);
    const activity = await call("/api/node/activity", { cookie }).catch(() => null);
    const busy = (activity?.turns ?? []).some((turn) => ["queued", "running"].includes(turn.status));
    quiet = busy ? 0 : quiet + 1;
    const waitingLogin = fresh.some((row) => row.kind === "approval" && row.data?.type === "login" && ["pending", "working"].includes(row.data?.status));
    if (quiet >= 2 && (fresh.some((row) => row.authorKind === "node" && row.kind === "text") || waitingLogin)) break;
  }
  const replies = fresh.filter((row) => row.authorKind === "node" && row.kind === "text");
  const text = replies.map((row) => row.body).join("\n");
  const chips = replies.flatMap((row) => (Array.isArray(row.data?.tools) ? row.data.tools : []));
  const used = new Set(chips.filter((tool) => !["failed", "blocked", "error"].includes(String(tool.state))).map((tool) => tool.name));
  const media = fresh.filter((row) => row.authorKind === "node").flatMap((row) => (Array.isArray(row.data?.media) ? row.data.media.map((item) => ({ ...item, messageId: row.id })) : []));
  const cards = fresh.filter((row) => row.kind === "approval").map((row) => `${row.data?.type}:${row.data?.status}`);
  // Every picture and file, to look at.
  const saved = [];
  for (const [n, item] of media.entries()) {
    const response = await call(`/api/node/evidence/${item.evidenceId}?message=${item.messageId}`, { cookie, raw: true }).catch(() => null);
    if (!response?.ok) continue;
    const ext = (item.name?.split(".").at(-1) ?? "bin").slice(0, 5);
    const path = join(OUT, `case${index + 1}-${n + 1}.${ext}`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
    saved.push(path);
  }
  const files = item.file ? ((await call("/api/documents", { cookie }).catch(() => ({ files: [] }))).files ?? []) : [];
  const looks = [];
  if (item.look) for (const path of saved) looks.push({ path, ...((await lookAt(path, item.look)) ?? { pass: null, why: "not judged" }) });
  const problems = [];
  for (const group of item.tools ?? []) if (!group.some((name) => used.has(name) || cards.some((card) => card.startsWith("login") && name === "browser_login_needed"))) problems.push(`missing ${group.join("|")}`);
  if (item.media && media.filter((row) => /image|screenshot/.test(row.kind) || /^image\//.test(row.mime ?? "")).length < item.media) problems.push(`media ${media.length}/${item.media}`);
  if (item.table && !/^\s*\|.*\|\s*$/m.test(text)) problems.push("no table");
  if (item.says && !item.says.test(text)) problems.push(`reply lacks ${item.says}`);
  if (item.file && !files.some((row) => item.file.test(row.filename ?? row.name ?? ""))) problems.push("no file in Ensemble Files");
  if (item.card && !cards.some((card) => card.startsWith(item.card))) problems.push(`no ${item.card} card`);
  const failedLooks = looks.filter((look) => look.pass === false);
  if (failedLooks.length) problems.push(`pictures wrong ${failedLooks.length}/${looks.length}: ${failedLooks.map((look) => `${look.path.split("/").at(-1)} (${look.why})`).join("; ")}`);
  if (CHATTER.test(text)) problems.push("asks for a password or approval in words");
  // A broken Ensemble link in the reply.
  for (const match of text.matchAll(/ensemble:\/\/file\/([0-9a-f-]{36})/g)) if (!files.some((row) => row.id === match[1])) problems.push(`broken link ${match[0]}`);
  // Sign-in cards are left waiting for no one: decline them.
  for (const card of fresh.filter((row) => row.kind === "approval" && row.data?.type === "login" && row.data?.status === "pending")) {
    await call(`/api/node/approvals/${card.id}`, { method: "POST", cookie, body: { decision: "discard" } }).catch(() => undefined);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`${node.model}:${node.effort} #${index + 1} ${problems.length ? `FAIL ${problems.join("; ")}` : "ok"} [${[...used].join(", ")}] media=${media.length} cards=${cards.join(",") || "-"} ${seconds}s`);
  return { index: index + 1, ask: item.ask, ok: problems.length === 0, problems, used: [...used], media: saved, looks, cards, seconds, reply: text.replace(/\s+/g, " ").slice(0, 600) };
}

mkdirSync(OUT, { recursive: true });
console.log(`screenshots and files: ${OUT}`);
const computer = await bootComputer();
const results = [];
try {
  for (const pick of MODELS) {
    const cookie = await signup(`${pick.model.replace(/[^a-z0-9]/gi, "")}${pick.effort}`);
    await pairComputer(cookie, computer);
    const { node, room } = await call("/api/node/nodes", { method: "POST", cookie, body: { templateId: "assistant" } });
    await call(`/api/node/nodes/${node.id}`, { method: "PATCH", cookie, body: { model: pick.model, effort: pick.effort } });
    const rows = [];
    for (const [index, item] of CASES.entries()) {
      if (ONLY && !ONLY.has(index + 1)) continue;
      try {
        rows.push(await runCase(cookie, room, pick, item, index));
      } catch (error) {
        console.log(`${pick.model}:${pick.effort} #${index + 1} ERROR ${error instanceof Error ? error.message : String(error)}`);
        rows.push({ index: index + 1, ok: false, problems: ["error"], error: String(error) });
      }
    }
    results.push({ ...pick, rows });
  }
} finally {
  await computer.stop();
  writeFileSync(join(OUT, "computer.log"), computer.logs());
  if (!process.env.NODE_EVAL_KEEP) rmSync(computer.root, { recursive: true, force: true });
}
console.log("\nmodel:effort        passed");
for (const result of results) console.log(`${`${result.model}:${result.effort}`.padEnd(20)} ${result.rows.filter((row) => row.ok).length}/${result.rows.length}`);
writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
