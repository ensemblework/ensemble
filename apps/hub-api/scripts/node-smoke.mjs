/**
 * A crew run end to end against a running hub-api, with the server's real models and a scripted
 * computer (docs/35 §11): the reported incident, live. Signs up, pairs a pretend computer that shares
 * "live-test" and runs Codex, makes a crew (lead, builder, tester), asks for two features one at a
 * time, each checked independently, and answers every agent run from its packet: the first check
 * fails, so the build must be repaired and checked again before the second feature starts. It asks
 * the lead how it is going while the work runs, then prints the crew's timeline and a verdict.
 *
 *   HUB_API=http://127.0.0.1:4098 node apps/hub-api/scripts/node-smoke.mjs
 *
 * Use it against a local server (a sign-up must not need Turnstile). It spends included credits.
 */
const API = process.env.HUB_API ?? "http://127.0.0.1:4098";
const LIMIT_MS = Number(process.env.NODE_SMOKE_LIMIT_MS ?? 15 * 60_000);
const stamp = Date.now().toString(36);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cookieOf(response) {
  const list = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error("sign-up did not set a session");
  return pair[1];
}

async function call(path, { method = "GET", token, cookie, body, allow = [] } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = `ensemble_session=${cookie}`;
  const response = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok && !allow.includes(response.status)) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 400)}`);
  return parsed;
}

const signup = await fetch(`${API}/api/auth/signup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: `node-smoke-${stamp}@ensemble.test`, password: `node-smoke-pass-${stamp}`, name: "Smoke" }),
});
if (!signup.ok) throw new Error(`sign-up ${signup.status}: ${await signup.text()}`);
const cookie = cookieOf(signup);
console.log(`account node-smoke-${stamp}@ensemble.test`);

// A pretend computer: shares live-test, runs Codex and Claude Code, continues sessions, takes reports.
const paired = await call("/api/devices/pair", { method: "POST", cookie, body: {} });
const registered = await call("/api/devices/register", {
  method: "POST",
  body: { code: paired.code, name: "Smoke laptop", platform: "linux", appVersion: "0.5.0", capabilities: { folders: ["live-test"], engines: ["codex", "claude-code"], sessions: 1, secrets: 1, evidence: 1 } },
});
const device = registered.token;
await call("/api/settings", {
  method: "PATCH",
  cookie,
  body: { runProfiles: [{ id: "smoke", name: "Smoke", engine: "codex", mode: "unattended", delivery: "local", deviceId: registered.device.id }], defaultRunProfileId: "smoke" },
});

const nodes = {};
for (const template of ["manager", "feature-engineer", "tester"]) nodes[template] = (await call("/api/node/nodes", { method: "POST", cookie, body: { templateId: template } })).node;
const crew = (await call("/api/node/crews", { method: "POST", cookie, body: { title: `Smoke crew ${stamp}`, nodeIds: Object.values(nodes).map((node) => node.id), leadNodeId: nodes.manager.id } })).room;
console.log(`crew: lead @${nodes.manager.slug}, builder @${nodes["feature-engineer"].slug}, tester @${nodes.tester.slug}`);

// The computer: every run is answered from its packet, as a coding agent would report it.
const jobs = [];
let failedOnce = false;
let stopDevice = false;
const commit = () => Math.random().toString(16).slice(2, 9);

function packetOf(claim) {
  const strings = [];
  (function walk(value) {
    if (typeof value === "string") strings.push(value);
    else if (value && typeof value === "object") for (const item of Object.values(value)) walk(item);
  })(claim);
  return strings.find((text) => text.includes("## Your part")) ?? strings.find((text) => text.includes("without reporting your result")) ?? strings.join("\n");
}

function answerFor(packet) {
  const acceptance = [...packet.matchAll(/^\s+- ([A-Za-z0-9_.:-]+)(?: \(must pass\))?: /gm)].map((match) => match[1]);
  const checks = (verdict) => (acceptance.length ? acceptance : ["A1"]).map((id) => ({ id, name: `criterion ${id}`, verdict, ...(verdict === "fail" ? { detail: "A title containing | splits the table cell." } : {}) }));
  if (/without reporting your result/.test(packet)) return { outcome: "done", summary: "Reported on request: the change is in.", subject: { branch: "live-testing", commit: commit() } };
  const part = packet.split("## Your part")[1]?.split("## Constraints")[0] ?? "";
  const verify = /You check|The work you checked was repaired|independent check/i.test(part) && /Do not fix what you test/.test(part);
  if (!verify) return { outcome: "done", summary: /FAILED/.test(part) ? "Repaired: pipes are escaped in every cell now." : "Built it and committed.", subject: { branch: "live-testing", commit: commit() } };
  if (!failedOnce) {
    failedOnce = true;
    return { outcome: "fail", summary: "A record title with | still breaks the table.", checks: checks("fail"), subject: { commit: commit() } };
  }
  return { outcome: "pass", summary: "Every criterion passes.", checks: checks("pass"), subject: { commit: commit() } };
}

const computer = (async () => {
  while (!stopDevice) {
    await call("/api/devices/self/heartbeat", { method: "POST", token: device, body: { runningJobIds: [] } }).catch(() => undefined);
    const claimed = await call("/api/devices/self/claim", { method: "POST", token: device, body: {}, allow: [204, 404] }).catch(() => null);
    if (claimed?.leaseToken) {
      const packet = packetOf(claimed);
      const title = /^(?:Build|Check|Retest|Repair|Write|Work|Report)[^\n]*/m.exec(JSON.stringify(claimed.title ?? claimed.task?.title ?? ""))?.[0] ?? claimed.title ?? claimed.task?.title ?? "?";
      const report = answerFor(packet);
      jobs.push({ id: claimed.id, title, outcome: report.outcome, packetChars: packet.length });
      console.log(`  computer: ${String(title).slice(0, 70)} → ${report.outcome}`);
      await call(`/api/devices/self/jobs/${claimed.id}/progress`, { method: "POST", token: device, body: { leaseToken: claimed.leaseToken, status: "running", progress: "Working" } });
      await sleep(1500);
      await call(`/api/devices/self/jobs/${claimed.id}/complete`, { method: "POST", token: device, body: { leaseToken: claimed.leaseToken, outcome: "succeeded", summary: report.summary, report } });
    }
    await sleep(2000);
  }
})();

// The owner's request, as written in the reported incident (synthetic).
await call(`/api/node/rooms/${crew.id}/messages`, {
  method: "POST",
  cookie,
  body: {
    body: "In my live-test folder, on the live-testing branch (push there), please: 1) fix Markdown tables in node messages so record titles containing | stay in one cell, and have it tested independently; 2) only after that passes, make Needs Me requests expire when their task ends, and have that tested too. One feature at a time. Use Codex for all the work.",
  },
});

const started = Date.now();
const seen = new Set();
let asked = false;
let plan = null;
while (Date.now() - started < LIMIT_MS) {
  await sleep(3000);
  const { messages } = await call(`/api/node/rooms/${crew.id}/messages`, { cookie });
  for (const message of messages) {
    const key = `${message.id}:${message.kind === "plan" ? message.data?.status : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const who = message.authorKind === "human" ? "owner" : `@${Object.values(nodes).find((node) => node.id === message.authorNodeId)?.slug ?? "node"}`;
    if (message.kind === "plan") {
      plan = message;
      const steps = (message.data?.steps ?? []).map((step) => `${step.handle}:${step.kind}:${step.status}/${step.outcome}${step.attempt > 1 ? `#${step.attempt}` : ""}`).join(" ");
      console.log(`[${Math.round((Date.now() - started) / 1000)}s] plan ${message.data?.status}: ${steps}`);
    } else {
      console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${message.kind} ${who}: ${String(message.body).replace(/\s+/g, " ").slice(0, 220)}`);
    }
  }
  // Ask how it is going while the work runs: the lead answers from its work board, at once.
  if (!asked && plan?.data?.status === "running" && jobs.length >= 2) {
    asked = true;
    await call(`/api/node/rooms/${crew.id}/messages`, { method: "POST", cookie, body: { body: "how is it going?" } });
  }
  if (plan && ["succeeded", "partially_completed", "failed", "stopped"].includes(plan.data?.status) && Date.now() - started > 10_000) {
    await sleep(8000);
    break;
  }
}
stopDevice = true;
await computer;

const { messages } = await call(`/api/node/rooms/${crew.id}/messages`, { cookie });
const nodeTexts = messages.filter((message) => message.kind === "text" && message.authorKind === "node");
const final = messages.filter((message) => message.kind === "plan").at(-1);
const steps = final?.data?.steps ?? [];
const summary = {
  planStatus: final?.data?.status ?? "no plan",
  requirements: (final?.data?.requirements ?? []).map((row) => `${row.id}:${row.status}`),
  constraints: final?.data?.constraints ?? null,
  steps: steps.map((step) => ({ handle: step.handle, kind: step.kind, status: step.status, outcome: step.outcome, attempts: step.attempts?.length ?? 0 })),
  computerRuns: jobs.length,
  nodeMessagesInCrew: nodeTexts.length,
  timelineItems: messages.length,
  seconds: Math.round((Date.now() - started) / 1000),
};
console.log(JSON.stringify(summary, null, 2));
const featureBStartedAfterPass = (() => {
  const order = jobs.map((job) => job.outcome);
  const firstFail = order.indexOf("fail");
  const firstPass = order.indexOf("pass");
  return firstFail !== -1 && firstPass > firstFail;
})();
const verdict = [
  ["the plan succeeded", summary.planStatus === "succeeded"],
  ["the failed check was repaired and passed before the next feature", featureBStartedAfterPass],
  ["at most 5 node messages in the crew", nodeTexts.length <= 5],
];
for (const [name, ok] of verdict) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
process.exit(verdict.every(([, ok]) => ok) ? 0 : 1);
