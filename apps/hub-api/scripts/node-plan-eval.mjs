/**
 * The planning evaluation (ensemble-node docs/design B0): ten planning requests, each with the
 * deliverables a good plan must cover, given to a crew's lead on each model under test. For each it
 * records whether the lead handled it (a plan; or, where the request names no source it can find, a
 * question back instead of starting work), the requirement recall (each expected deliverable named by
 * a requirement, over the plans), whether a check was planned where one was asked for, and serial
 * order where asked.
 * Not a CI gate: it informs the lead's default model (design decisions 2 and 8).
 *
 *   HUB_API=http://127.0.0.1:4098 node apps/hub-api/scripts/node-plan-eval.mjs
 *
 * Run it against a local server (sign-up without Turnstile); every plan is stopped as soon as it is
 * made, so no work runs. It spends included credits.
 */
const API = process.env.HUB_API ?? "http://127.0.0.1:4098";
const MODELS = (process.env.NODE_EVAL_MODELS ?? "gpt-6-luna:low,gpt-6.1-sol:low,gpt-6.1-sol:medium").split(",").map((pair) => {
  const [model, effort] = pair.split(":");
  return { model, effort };
});
const stamp = Date.now().toString(36);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CASES = [
  { ask: "Fix the login redirect bug in my app folder and have it tested independently.", expect: [["login", "redirect"]], check: true },
  { ask: "In my app folder: add CSV export to the reports page, add PDF export too, and update the user guide for both. Test each export.", expect: [["csv"], ["pdf"], ["guide", "doc"]], check: true },
  { ask: "One at a time, each tested before the next: 1) make Needs Me requests expire when their task ends, 2) show unread counts in the sidebar, 3) add keyboard shortcuts for the composer. Work in my app folder on the testing branch.", expect: [["expire", "needs me"], ["unread"], ["shortcut", "keyboard"]], check: true, serial: true },
  { ask: "Research the three most used open-source vector databases and write me a one-page comparison.", expect: [["vector", "database", "comparison"]] },
  { ask: "Build a small Electron app in my app folder that shows my GitHub notifications, test that it starts, and send me a screenshot.", expect: [["electron", "notification"]], check: true },
  { ask: "Refactor the billing module in my app folder to use cents instead of decimals, keep the API unchanged, and run the full test suite.", expect: [["billing", "cents"]], check: true },
  { ask: "Write release notes for version 2.4 from the merged pull requests, and draft an announcement email.", expect: [["release notes"], ["email", "announcement"]], clarify: true },
  { ask: "In my app folder: fix the flaky upload test, then upgrade React to the latest version, then check nothing broke. Push to the staging branch.", expect: [["flaky", "upload"], ["react", "upgrade"]], check: true },
  { ask: "Add dark mode to the settings page and the dashboard in my app folder, with screenshots of both, and have someone else verify them.", expect: [["dark mode", "settings"], ["dashboard"]], check: true },
  { ask: "Audit our onboarding docs for out-of-date steps and fix them, then summarise what changed for me.", expect: [["onboarding", "docs", "audit"]], clarify: true },
];

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

async function account(label) {
  const signup = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `node-eval-${label}-${stamp}@ensemble.test`, password: `node-eval-pass-${stamp}`, name: "Eval" }),
  });
  if (!signup.ok) throw new Error(`sign-up ${signup.status}: ${await signup.text()}`);
  const cookie = (signup.headers.getSetCookie?.() ?? []).join(",").match(/ensemble_session=([^;]+)/)?.[1];
  const paired = await call("/api/devices/pair", { method: "POST", cookie, body: {} });
  const registered = await call("/api/devices/register", { method: "POST", body: { code: paired.code, name: "Eval laptop", platform: "linux", appVersion: "0.5.0", capabilities: { folders: ["app"], engines: ["codex"], sessions: 1 } } });
  await call("/api/settings", { method: "PATCH", cookie, body: { runProfiles: [{ id: "eval", name: "Eval", engine: "codex", mode: "unattended", delivery: "local", deviceId: registered.device.id }], defaultRunProfileId: "eval" } });
  return cookie;
}

async function runModel({ model, effort }) {
  const cookie = await account(`${model.replace(/[^a-z0-9]/gi, "")}${effort}`);
  const ids = {};
  for (const template of ["manager", "feature-engineer", "tester", "researcher"]) ids[template] = (await call("/api/node/nodes", { method: "POST", cookie, body: { templateId: template } })).node;
  await call(`/api/node/nodes/${ids.manager.id}`, { method: "PATCH", cookie, body: { model, effort } });
  const crew = (await call("/api/node/crews", { method: "POST", cookie, body: { title: `Eval ${model} ${effort}`, nodeIds: Object.values(ids).map((node) => node.id), leadNodeId: ids.manager.id } })).room;
  const rows = [];
  for (const [index, item] of CASES.entries()) {
    const before = new Set((await call(`/api/node/rooms/${crew.id}/messages`, { cookie })).messages.map((row) => row.id));
    const started = Date.now();
    await call(`/api/node/rooms/${crew.id}/messages`, { method: "POST", cookie, body: { body: item.ask } });
    let plan = null;
    let reply = null;
    let ran = false;
    while (Date.now() - started < 180_000) {
      await sleep(3000);
      const fresh = (await call(`/api/node/rooms/${crew.id}/messages`, { cookie })).messages.filter((row) => !before.has(row.id));
      plan = fresh.find((row) => row.kind === "plan") ?? null;
      reply = fresh.find((row) => row.kind === "text" && row.authorKind === "node") ?? null;
      ran = fresh.some((row) => row.kind === "run");
      const turns = (await call("/api/node/activity", { cookie })).turns ?? [];
      const busy = turns.some((turn) => turn.nodeId === ids.manager.id && ["queued", "running"].includes(turn.status));
      if (!busy && (plan || reply)) break;
    }
    if (plan && ["draft", "running"].includes(plan.data?.status)) await call(`/api/node/plans/${plan.id}/stop`, { method: "POST", cookie }).catch(() => undefined);
    const data = plan ? (await call(`/api/node/plans/${plan.id}`, { cookie })).message.data : null;
    const texts = (data?.requirements ?? []).map((row) => `${row.text} ${(row.acceptance ?? []).map((a) => a.text).join(" ")}`.toLowerCase());
    const stepText = (data?.steps ?? []).map((step) => step.brief.toLowerCase()).join(" ");
    const covered = item.expect.filter((group) => group.some((word) => texts.some((text) => text.includes(word)) || (!texts.length && stepText.includes(word))));
    const hasCheck = (data?.steps ?? []).some((step) => step.kind === "verify");
    const asked = Boolean(item.clarify && !plan && reply && !ran);
    rows.push({
      case: index + 1,
      plan: Boolean(plan),
      handled: Boolean(plan) || asked,
      asked,
      contract: data?.contract ?? null,
      requirements: data?.requirements?.length ?? 0,
      recall: asked ? null : `${covered.length}/${item.expect.length}`,
      check: item.check ? hasCheck : null,
      serial: item.serial ? data?.constraints?.order === "serial" : null,
      steps: data?.steps?.length ?? 0,
      seconds: Math.round((Date.now() - started) / 1000),
    });
    console.log(`${model}:${effort} case ${index + 1}: ${JSON.stringify(rows.at(-1))}`);
    // Let the stop settle before the next request.
    await sleep(4000);
  }
  return { model, effort, rows };
}

const results = await Promise.all(MODELS.map((pick) => runModel(pick).catch((error) => ({ ...pick, error: String(error), rows: [] }))));
console.log("\nmodel              handled  recall   checks  serial  avg s");
for (const result of results) {
  if (result.error) {
    console.log(`${result.model}:${result.effort} failed: ${result.error}`);
    continue;
  }
  const rows = result.rows;
  const scored = rows.filter((row) => row.recall !== null);
  const recallHit = scored.reduce((sum, row) => sum + Number(row.recall.split("/")[0]), 0);
  const recallAll = scored.reduce((sum, row) => sum + Number(row.recall.split("/")[1]), 0);
  const checks = rows.filter((row) => row.check !== null);
  const serial = rows.filter((row) => row.serial !== null);
  const avg = Math.round(rows.reduce((sum, row) => sum + row.seconds, 0) / Math.max(1, rows.length));
  console.log(
    `${`${result.model}:${result.effort}`.padEnd(19)}${`${rows.filter((row) => row.handled).length}/${rows.length}`.padEnd(9)}${`${recallHit}/${recallAll}`.padEnd(9)}${`${checks.filter((row) => row.check).length}/${checks.length}`.padEnd(8)}${`${serial.filter((row) => row.serial).length}/${serial.length}`.padEnd(8)}${avg}`,
  );
}
