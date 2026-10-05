/**
 * One remote task, end to end, against a running hub-api.
 *
 *   HUB_API=http://127.0.0.1:4000 node apps/hub-api/scripts/fake-device.mjs
 *
 * Signs up, pairs a pretend Windows computer, assigns a public-repo task, then claims,
 * reports progress and a log line, asks a question, answers Yes, and completes.
 * A signed-in page cannot turn run-branch push on.
 * claim.networkAccess is this Ensemble's sandbox hint. This computer ignores it.
 * `device.revoked` on the event stream stops the run.
 */
const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const stamp = Date.now().toString(36);

function cookieHeader(response) {
  const list = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error("signup did not set a session");
  return pair[1];
}

async function call(path, { method = "GET", token, cookie, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = `ensemble_session=${cookie}`;
  const response = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text}`);
  return parsed;
}

const signup = await fetch(`${API}/api/auth/signup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: `fake-device-${stamp}@ensemble.test`, password: "fake-device-pass-1", name: "Fake device" }),
});
if (!signup.ok) throw new Error(`signup ${signup.status}: ${await signup.text()}`);
const session = cookieHeader(signup);

const task = await call("/api/tasks", { method: "POST", cookie: session, body: { title: "Remote hello", status: "todo" } });
const taskId = task.task?.id ?? task.id;
if (!taskId) throw new Error(`no task id in ${JSON.stringify(task)}`);

const paired = await call("/api/devices/pair", { method: "POST", cookie: session, body: {} });
const registered = await call("/api/devices/register", {
  method: "POST",
  body: { code: paired.code, name: "Studio PC", platform: "windows", appVersion: "fake", capabilities: { folders: ["Notes"], runBranchPush: false } },
});

function watchRevoked(token, signal) {
  return (async () => {
    const response = await fetch(`${API}/api/devices/self/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`events ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf("\n\n");
        if (!frame.split("\n").some((line) => line.startsWith("event: device.revoked"))) continue;
        const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
        throw new Error(`device revoked${dataLine ? `: ${dataLine.slice(6)}` : ""}`);
      }
    }
  })();
}

const eventsAbort = new AbortController();
let revokedError = null;
const revoked = watchRevoked(registered.token, eventsAbort.signal).catch((error) => {
  if (error?.name === "AbortError") return;
  revokedError = error;
});
function stillPaired() {
  if (revokedError) throw revokedError;
}

const assigned = await call("/api/agent/assign", {
  method: "POST",
  cookie: session,
  body: { taskId, kind: "code", deviceId: registered.device.id, repoUrl: "octocat/Hello-World", instructions: "Say hello from the fake device." },
});

stillPaired();
await call("/api/devices/self/heartbeat", { method: "POST", token: registered.token, body: { runningJobIds: [] } });
stillPaired();
const claimed = await call("/api/devices/self/claim", { method: "POST", token: registered.token, body: {} });
if (!claimed?.leaseToken) throw new Error("claim did not return a job");
// networkAccess is optional and only a hint. The computer keeps its own network setting.
if ("networkAccess" in claimed && typeof claimed.networkAccess !== "boolean" && claimed.networkAccess != null) {
  throw new Error("networkAccess must be a boolean hint or absent");
}

await call(`/api/devices/self/jobs/${claimed.id}/progress`, {
  method: "POST",
  token: registered.token,
  body: {
    leaseToken: claimed.leaseToken,
    status: "running",
    progress: "Reading the repo",
    events: [{ kind: "prepared", data: { root: "runs/fake" } }],
    logs: { seqFrom: 1, seqTo: 1, text: "hello from the fake device\n" },
  },
});

const asked = await call(`/api/devices/self/jobs/${claimed.id}/ask`, {
  method: "POST",
  token: registered.token,
  body: { leaseToken: claimed.leaseToken, title: "Continue?", event: "question", tier: "ordinary" },
});
await call(`/api/decisions/${asked.decisionId}/decide`, { method: "POST", cookie: session, body: { decision: "allow", scope: "once" } });
await call(`/api/devices/self/jobs/${claimed.id}/progress`, {
  method: "POST",
  token: registered.token,
  body: { leaseToken: claimed.leaseToken, status: "running", progress: "Continuing" },
});

stillPaired();
const done = await call(`/api/devices/self/jobs/${claimed.id}/complete`, {
  method: "POST",
  token: registered.token,
  body: {
    leaseToken: claimed.leaseToken,
    outcome: "succeeded",
    summary: "Said hello.",
    results: [{ kind: "commit", url: "https://github.com/octocat/Hello-World/commit/abc1234", sha: "abc1234" }],
  },
});

const job = await call(`/api/agent/jobs/${claimed.id}`, { cookie: session });
const logs = await call(`/api/agent/jobs/${claimed.id}/logs?after=0`, { cookie: session });
if (job.job.status !== "succeeded") throw new Error(`expected succeeded, got ${job.job.status}`);
if (!logs.chunks.some((chunk) => chunk.text.includes("hello from the fake device"))) throw new Error("log chunk missing");

const listed = await call("/api/devices", { cookie: session });
const studio = listed.devices.find((device) => device.name === "Studio PC");
if (!studio || studio.platform !== "windows") throw new Error(`expected a Windows computer, got ${JSON.stringify(listed.devices)}`);
const flip = await fetch(`${API}/api/devices/self/heartbeat`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
  body: JSON.stringify({ runningJobIds: [], capabilities: { runBranchPush: true } }),
});
if (flip.status !== 403) throw new Error(`web set run-branch push: ${flip.status} ${await flip.text()}`);
const after = await call("/api/devices", { cookie: session });
if (after.devices.find((device) => device.id === studio.id)?.runBranchPush) throw new Error("run-branch push flipped from the page");

stillPaired();
eventsAbort.abort();
await revoked;
console.log(JSON.stringify({ jobId: claimed.id, status: done.status, deviceId: registered.device.id, platform: studio.platform, logs: logs.chunks.length }, null, 2));
