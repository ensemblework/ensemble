/**
 * A node's everyday behaviours against a running hub-api with the server's real models (docs/35 §11),
 * the second smoke scenario: two helpers in parallel report once; a routine made from chat; a new node
 * proposed on a card, not made; a message that is only "stop" stops work without a model.
 *
 *   HUB_API=http://127.0.0.1:4098 node apps/hub-api/scripts/node-smoke-dm.mjs
 *
 * Use it against a local server (a sign-up must not need Turnstile). It spends included credits.
 */
const API = process.env.HUB_API ?? "http://127.0.0.1:4098";
const stamp = Date.now().toString(36);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, { method = "GET", cookie, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = `ensemble_session=${cookie}`;
  const response = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`);
  return parsed;
}

const signup = await fetch(`${API}/api/auth/signup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: `node-smoke-dm-${stamp}@ensemble.test`, password: `node-smoke-pass-${stamp}`, name: "Smoke" }),
});
if (!signup.ok) throw new Error(`sign-up ${signup.status}: ${await signup.text()}`);
const cookie = (signup.headers.getSetCookie?.() ?? []).join(",").match(/ensemble_session=([^;]+)/)?.[1];
const { node, room } = await call("/api/node/nodes", { method: "POST", cookie, body: { templateId: "assistant" } });

async function timeline() {
  return (await call(`/api/node/rooms/${room.id}/messages`, { cookie })).messages;
}
/** Waits until nothing of the node's is running (no turn in progress and the newest plan ended), then a little more. */
async function settle(limitMs = 240_000) {
  const started = Date.now();
  let quiet = 0;
  while (Date.now() - started < limitMs) {
    await sleep(3000);
    const activity = await call("/api/node/activity", { cookie }).catch(() => null);
    const busy = (activity?.turns ?? []).some((turn) => ["queued", "running"].includes(turn.status));
    const plans = (await timeline()).filter((row) => row.kind === "plan");
    const live = plans.some((plan) => ["draft", "running", "reporting"].includes(plan.data?.status));
    quiet = busy || live ? 0 : quiet + 1;
    if (quiet >= 2) return;
  }
}
async function say(body) {
  const before = (await timeline()).length;
  await call(`/api/node/rooms/${room.id}/messages`, { method: "POST", cookie, body: { body } });
  await settle();
  const rows = (await timeline()).slice(before);
  for (const row of rows) {
    const who = row.authorKind === "human" ? "owner" : `@${node.slug}`;
    const extra = row.kind === "plan" ? ` [${row.data?.status}: ${(row.data?.steps ?? []).map((step) => `${step.handle}/${step.executor}/${step.status}`).join(" ")}]` : row.kind === "approval" ? ` [${row.data?.type} ${row.data?.status}]` : "";
    console.log(`  ${row.kind} ${who}: ${String(row.body).replace(/\s+/g, " ").slice(0, 200)}${extra}`);
  }
  return rows;
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log("1. Two helpers in parallel");
let rows = await say("Get two independent helpers to research in parallel: one on the pros of SQLite for a small app, one on the pros of PostgreSQL. Then tell me which you would pick, in a few lines.");
const helpers = await call("/api/node/rooms", { cookie }).then((data) => (data.rooms ?? []).filter((row) => row.kind === "task"));
const texts = rows.filter((row) => row.kind === "text" && row.authorKind === "node");
check("two helpers were brought in", helpers.length >= 2, `${helpers.length} helper threads`);
check("their node told its owner once", texts.length === 1, texts.map((row) => row.body.slice(0, 80)).join(" | "));

console.log("2. A routine from chat");
rows = await say("Every weekday at 9:00 in Asia/Kolkata, tell me in two lines what is due today.");
const routines = (await call("/api/node/routines", { cookie })).routines;
check("a routine was made", routines.length === 1, routines.map((row) => `${row.title}: ${row.when}`).join("; "));

console.log("3. A new node is proposed, not made");
rows = await say("Make me a new node called Release watcher that tracks our releases and tells me what shipped.");
const proposal = rows.find((row) => row.kind === "approval" && row.data?.type === "node_proposal");
const nodes = (await call("/api/node/nodes", { cookie })).nodes;
check("a proposal card, and no node yet", Boolean(proposal) && !nodes.some((row) => row.name === "Release watcher"));

console.log("4. Stop without a model");
await call(`/api/node/rooms/${room.id}/messages`, { method: "POST", cookie, body: { body: "Research the history of the Unix pipe in depth across several sources and write me a long report." } });
await sleep(6000);
const before = (await timeline()).length;
await call(`/api/node/rooms/${room.id}/messages`, { method: "POST", cookie, body: { body: "stop" } });
await settle(60_000);
rows = (await timeline()).slice(before);
for (const row of rows) console.log(`  ${row.kind} ${row.authorKind}: ${String(row.body).replace(/\s+/g, " ").slice(0, 160)}`);
const stopped = rows.some((row) => row.kind === "status" || /Stopped/.test(row.body));
check("stop answered by a status line", stopped);

process.exit(results.every(([, ok]) => ok) ? 0 : 1);
