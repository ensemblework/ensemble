/**
 * The routing evaluation (docs/35 §11): the owner's own everyday requests, given to a node in its DM
 * on each model under test, with a fake paired computer that answers every computer tool at once.
 * For each request it records which tools the node used and checks the route: simple work on the
 * computer the node does itself (a terminal screenshot, a command, a file, a download and install with
 * sudo, a web page's screenshot), prices and facts from web search, and only coding goes to an agent
 * session. It also checks the reply: no "please approve" chatter, a Markdown table when one was asked.
 * Not a CI gate: it informs the node's default model.
 *
 *   HUB_API=http://127.0.0.1:4098 node apps/hub-api/scripts/node-route-eval.mjs
 *   NODE_EVAL_MODELS=gpt-6-luna:low,gpt-6-luna:medium,gpt-6.1-sol:low
 *
 * Run it against a local server (sign-up without Turnstile), or a hosted one with a verified test
 * account (NODE_SMOKE_EMAIL, NODE_SMOKE_PASSWORD). It spends included credits.
 */
import { createHash, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";

const API = process.env.HUB_API ?? "http://127.0.0.1:4098";
const MODELS = (process.env.NODE_EVAL_MODELS ?? "gpt-6-luna:low,gpt-6-luna:medium,gpt-6.1-sol:low").split(",").map((pair) => {
  const [model, effort] = pair.split(":");
  return { model, effort };
});
const ONLY = process.env.NODE_EVAL_CASES ? new Set(process.env.NODE_EVAL_CASES.split(",").map(Number)) : null;
const stamp = Date.now().toString(36);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const AGENT = ["node_session_start", "node_session_send"];

const CASES = [
  { ask: "can you run htop on my shell and send me a screenshot?", want: [["computer_terminal_screenshot"]], avoid: AGENT, media: true },
  { ask: "check how much disk space is left on my computer", want: [["computer_run", "computer_terminal_screenshot"]], avoid: AGENT },
  { ask: "what's the public IP address of my computer?", want: [["computer_run", "computer_terminal_screenshot"]], avoid: AGENT },
  { ask: "download Visual Studio Code (the .deb) for my linux machine and install it", want: [["computer_run", "hub_web_search", "browser_open"], ["computer_sudo"]], avoid: AGENT, sudo: true },
  { ask: "install htop on my computer", want: [["computer_sudo"]], avoid: AGENT, sudo: true },
  { ask: "take a screenshot of https://ensemblework.com and send it here", want: [["browser_open", "capture_screenshot"], ["browser_screenshot", "capture_screenshot"]], avoid: AGENT, media: true },
  { ask: "compare the price of a PS5 console at Best Buy, Walmart and Target (US). give me a table", want: [["hub_web_search", "browser_open"]], avoid: AGENT, table: true },
  { ask: "write a short markdown report of what you can do for me, save it as capabilities.md on my computer and send me the file here", want: [["computer_files_write", "computer_run"], ["node_share_file"]], avoid: AGENT, media: true },
  { ask: "in my app folder, fix the failing login test and commit the fix", want: [["node_session_start"]], avoid: [] },
  { ask: "add a dark mode toggle to the settings page of the project in my app folder", want: [["node_session_start"]], avoid: [] },
  { ask: "if you start a coding session for me, which agent and model will it use?", want: [], avoid: AGENT, says: /copilot/i },
];

/** Replies the owner should never see from a node. */
const CHATTER = /\b(please (approve|allow)|approve (it|the request|this) in|needs me|allow (it|access) and (re)?try|requested access|waiting for (your )?(approval|permission))\b/i;

async function call(path, { method = "GET", cookie, token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`);
  return parsed;
}

const CAPABILITIES = {
  folders: ["app"],
  engines: ["copilot-cli", "codex", "claude-code"],
  sessions: 2,
  nodeTools: 2,
  browser: 1,
  logins: 1,
  secrets: 2,
  capture: { browser: true, targets: { web: { screenshot: true, video: true }, terminal: { screenshot: true, tui: true } } },
};

/** A small real PNG (a grey picture), as a computer's screenshot would be. */
function png(width = 320, height = 200) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x88);
  for (let y = 0; y < height; y += 1) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** Uploads one file for a node's call (its uploadId), as a computer does; its evidence entry for the answer. */
async function upload(token, uploadId, name, kind, bytes, mime) {
  const id = randomUUID();
  const meta = { id, kind, name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mime, local: false, held: false };
  const response = await fetch(`${API}/api/devices/self/evidence-uploads/${encodeURIComponent(uploadId)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "x-ensemble-evidence": Buffer.from(JSON.stringify(meta)).toString("base64url") },
    body: bytes,
  });
  if (!response.ok) throw new Error(`evidence upload ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return { id, name, kind, held: false, local: false };
}

/** What the fake computer answers for each node tool call: a plausible, successful result. */
async function answerFor(request, token) {
  const tool = request.tool;
  const capture = async (summary, result, file) => {
    const evidence = file && request.uploadId ? [await upload(token, request.uploadId, ...file)] : [];
    return { status: 200, body: { ok: true, summary, result, evidence, refused: [] } };
  };
  const shot = (name) => [name, "image", png(), "image/png"];
  if (tool === "run") {
    const command = String(request.command ?? "");
    // Nothing the owner asks to install is there yet.
    if (/\b(which|command -v|type|dpkg(-query)? (-s|-l|--status|-W)|apt(-cache)? (list|policy|show)|snap list|flatpak list)\b/.test(command)) return { status: 200, body: { exitCode: 1, output: "", ms: 40 } };
    const output = /df\b/.test(command)
      ? "Filesystem      Size  Used Avail Use% Mounted on\n/dev/nvme0n1p2  915G  402G  467G  47% /\n"
      : /ifconfig|ipify|icanhazip|ip\.me|curl/.test(command)
        ? "203.0.113.42\n"
        : /uname|lsb_release|os-release/.test(command)
          ? "Ubuntu 24.04.1 LTS x86_64\n"
          : "done\n";
    return { status: 200, body: { exitCode: 0, output, ms: 180 } };
  }
  if (tool === "sudo") return { status: 200, body: { exitCode: 0, output: "Setting up the package ... done.\n", ms: 4200 } };
  if (tool === "terminal") return capture("Captured the terminal's screen.", { screen: "  1  [|||||     23.1%]   Tasks: 211, 1043 thr; 2 running\n  Mem[||||||||  6.12G/31.2G]   Load average: 0.42 0.51 0.48\n  PID USER  PRI  NI  VIRT   RES  CPU% MEM%  Command\n 1201 akash  20   0 4.1G  612M   8.0  1.9  node", exitCode: null, ended: false }, shot("terminal-htop.png"));
  if (tool === "git") return { status: 200, body: { exitCode: 0, output: "On branch main\nnothing to commit, working tree clean\n" } };
  if (tool === "http") return { status: 200, body: { status: 200, body: "ok" } };
  if (tool === "files") {
    if (request.action === "share") return capture(`Shared ${request.path}.`, null, [String(request.path).split("/").at(-1), "report", Buffer.from("# Capabilities\n\n- Browse\n- Screenshots\n"), "text/markdown"]);
    return { status: 200, body: { created: true, path: request.path } };
  }
  if (tool === "browser" || tool === "capture") {
    const name = request.name;
    if (name === "browser_open") return capture(`Opened ${request.input?.url ?? "the page"} in tab t1. Title: “Home”.`, { tab: "t1", url: request.input?.url ?? "", title: "Home" });
    if (name === "browser_snapshot") return capture("Page t1: Home. Headings: Welcome. Price: $499.99 (ref e12).", { tab: "t1" });
    if (name === "browser_screenshot" || name === "capture_screenshot") return capture("Saved the screenshot.", null, shot("screenshot.png"));
    return capture("Done.", null);
  }
  return { status: 200, body: {} };
}

/** A paired computer that stays online and answers every node tool call. */
async function fakeComputer(cookie, signal) {
  const paired = await call("/api/devices/pair", { method: "POST", cookie, body: {} });
  const registered = await call("/api/devices/register", { method: "POST", body: { code: paired.code, name: "Eval laptop", platform: "linux", appVersion: "0.6.0", capabilities: CAPABILITIES } });
  const token = registered.token;
  const calls = [];
  const heartbeat = () => call("/api/devices/self/heartbeat", { method: "POST", token, body: { capabilities: CAPABILITIES } }).catch(() => undefined);
  await heartbeat();
  const beat = setInterval(() => void heartbeat(), 20_000);
  signal.addEventListener("abort", () => clearInterval(beat), { once: true });
  void (async () => {
    while (!signal.aborted) {
      try {
        const response = await fetch(`${API}/api/devices/self/events`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let split = buffer.indexOf("\n\n");
          while (split >= 0) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            split = buffer.indexOf("\n\n");
            const event = frame.match(/^event: (.*)$/m)?.[1];
            const data = frame.match(/^data: (.*)$/m)?.[1];
            if (event !== "node.tool.request" || !data) continue;
            const request = JSON.parse(data);
            calls.push(request);
            const answer = await answerFor(request, token).catch((error) => ({ status: 500, body: { error: String(error) } }));
            await call(`/api/devices/self/code-requests/${encodeURIComponent(request.id)}`, { method: "POST", token, body: answer }).catch(() => undefined);
          }
        }
      } catch {
        if (signal.aborted) return;
        await sleep(1000);
      }
    }
  })();
  return { device: registered.device, calls };
}

/** A new account on a local server; against a hosted one (Turnstile), a verified test account: NODE_SMOKE_EMAIL and NODE_SMOKE_PASSWORD. */
async function signup(label) {
  const given = process.env.NODE_SMOKE_EMAIL && process.env.NODE_SMOKE_PASSWORD;
  const response = await fetch(`${API}/api/auth/${given ? "login" : "signup"}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(given ? { email: process.env.NODE_SMOKE_EMAIL, password: process.env.NODE_SMOKE_PASSWORD } : { email: `node-route-${label}-${stamp}@ensemble.test`, password: `node-route-pass-${stamp}`, name: "Eval" }),
  });
  if (!response.ok) throw new Error(`sign-up ${response.status}: ${await response.text()}`);
  const pair = (response.headers.getSetCookie?.() ?? []).join(",").match(/(ensemble_(?:[a-z0-9_]+_)?session)=([^;]+)/);
  if (!pair) throw new Error("signing up did not set a session");
  return `${pair[1]}=${pair[2]}`;
}

async function runModel({ model, effort }) {
  const cookie = await signup(`${model.replace(/[^a-z0-9]/gi, "")}${effort}`);
  const stop = new AbortController();
  const computer = await fakeComputer(cookie, stop.signal);
  await call("/api/settings", {
    method: "PATCH",
    cookie,
    body: { runProfiles: [{ id: "eval", name: "Default", engine: "copilot-cli", model: "gpt-6.1-sol", effort: "medium", context: "long_context", mode: "unattended", delivery: "local", deviceId: computer.device.id }], defaultRunProfileId: "eval" },
  });
  const { node, room } = await call("/api/node/nodes", { method: "POST", cookie, body: { templateId: "assistant" } });
  await call(`/api/node/nodes/${node.id}`, { method: "PATCH", cookie, body: { model, effort } });
  const rows = [];
  for (const [index, item] of CASES.entries()) {
    if (ONLY && !ONLY.has(index + 1)) continue;
    const seen = new Set((await call(`/api/node/rooms/${room.id}/messages`, { cookie })).messages.map((row) => row.id));
    const callsBefore = computer.calls.length;
    const started = Date.now();
    await call(`/api/node/rooms/${room.id}/messages`, { method: "POST", cookie, body: { body: item.ask } });
    let fresh = [];
    let quiet = 0;
    while (Date.now() - started < 240_000) {
      await sleep(3000);
      const activity = await call("/api/node/activity", { cookie }).catch(() => null);
      const busy = (activity?.turns ?? []).some((turn) => ["queued", "running"].includes(turn.status));
      fresh = (await call(`/api/node/rooms/${room.id}/messages`, { cookie })).messages.filter((row) => !seen.has(row.id));
      quiet = busy ? 0 : quiet + 1;
      if (quiet >= 2 && fresh.some((row) => row.authorKind === "node")) break;
    }
    // Cards the node posted (sudo, permissions): approve a sudo card so the work can go on.
    for (const card of fresh.filter((row) => row.kind === "approval" && row.data?.type === "sudo" && row.data?.status === "pending")) {
      await call(`/api/node/sudo/${card.id}`, { method: "POST", cookie, body: { action: "run" } }).catch(() => undefined);
      await sleep(15_000);
      fresh = (await call(`/api/node/rooms/${room.id}/messages`, { cookie })).messages.filter((row) => !seen.has(row.id));
    }
    const replies = fresh.filter((row) => row.authorKind === "node" && row.kind === "text");
    const allChips = replies.flatMap((row) => (Array.isArray(row.data?.tools) ? row.data.tools : []));
    // A tool counts when it worked (a refused or failed call is not the route taken).
    const chips = allChips.filter((tool) => !["failed", "blocked", "error"].includes(String(tool.state))).map((tool) => tool.name);
    const failedTools = allChips.filter((tool) => ["failed", "blocked", "error"].includes(String(tool.state))).map((tool) => `${tool.name}: ${String(tool.summary ?? "").slice(0, 120)}`);
    const deviceTools = computer.calls.slice(callsBefore).map((request) => (request.tool === "browser" || request.tool === "capture" ? request.name : request.tool === "files" && request.action === "share" ? "node_share_file" : request.tool === "terminal" ? "computer_terminal_screenshot" : request.tool === "sudo" ? "computer_sudo" : `computer_${request.tool === "files" ? "files_write" : request.tool}`));
    const cards = fresh.filter((row) => row.kind === "approval").map((row) => row.data?.type);
    const runs = fresh.filter((row) => row.kind === "run");
    const used = new Set([...chips, ...deviceTools, ...(runs.length ? ["node_session_start"] : []), ...(cards.includes("sudo") ? ["computer_sudo"] : [])]);
    const text = replies.map((row) => row.body).join("\n");
    const problems = [];
    for (const group of item.want) if (!group.some((name) => used.has(name))) problems.push(`missing ${group.join("|")}`);
    for (const name of item.avoid) if (used.has(name)) problems.push(`used ${name}`);
    if (item.table && !/^\s*\|.*\|\s*$/m.test(text)) problems.push("no table");
    const media = fresh.flatMap((row) => (row.authorKind === "node" && Array.isArray(row.data?.media) ? row.data.media : []));
    if (item.media && !media.length) problems.push("no media in the reply");
    if (item.says && !item.says.test(text)) problems.push(`reply lacks ${item.says}`);
    if (CHATTER.test(text)) problems.push("approval chatter");
    if (!replies.length) problems.push("no reply");
    rows.push({ index: index + 1, ask: item.ask, used: [...used], failedTools, cards, ok: problems.length === 0, problems, seconds: Math.round((Date.now() - started) / 1000), reply: text.replace(/\s+/g, " ").slice(0, 300) });
    console.log(`${model}:${effort} #${index + 1} ${problems.length ? "FAIL " + problems.join("; ") : "ok"} [${[...used].join(", ")}] ${Math.round((Date.now() - started) / 1000)}s`);
  }
  stop.abort();
  return rows;
}

const results = [];
for (const pick of MODELS) {
  try {
    results.push({ ...pick, rows: await runModel(pick) });
  } catch (error) {
    console.error(`${pick.model}:${pick.effort} could not run: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log("\nmodel:effort        passed");
for (const result of results) {
  const passed = result.rows.filter((row) => row.ok).length;
  console.log(`${`${result.model}:${result.effort}`.padEnd(20)} ${passed}/${result.rows.length}`);
}
console.log(JSON.stringify(results, null, 2));
