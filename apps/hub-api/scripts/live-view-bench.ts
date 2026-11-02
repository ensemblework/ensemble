/**
 * How fast a live view is (docs/35 §8.17), measured end to end: a hub-api on this machine (in this
 * process, a scripted model, an in-memory database) and this checkout's real computer runtime (the
 * CLI's sidecar, src/desktop/main.ts, in a data folder of its own) paired to it over HTTP. A node opens
 * a busy page, a page that flips on a click and a terminal, each with a live card; a simulated owner's
 * browser (the Node page's channel code from @ensemble/shared-types) opens them over HTTP, watches and
 * takes control, and counts what arrives: frames a second, bytes a frame (the JPEG or the terminal's
 * JSON, and what crossed the wire), and the time from sending input to the frame that shows it.
 *
 * Both legs can cross a slower link: `--profile home` puts the computer's uploads and the owner's
 * downloads through one shared uplink (as a home server behind Cloudflare carries every frame twice)
 * with a one-way delay. Not a CI test: it needs Chromium, an OS sandbox for the terminal, and time.
 *
 *   DATABASE_URL=postgresql://localhost/unused npx tsx scripts/live-view-bench.ts --out .bench
 *   … --profile home --uplink-kbps 4000 --latency-ms 30 --seconds 8 --transport poll|stream|auto
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, connect, type AddressInfo, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const OUT = resolve(option("out", ".live-view-bench")!);
const PROFILE = option("profile", "lan")!;
const UPLINK_KBPS = Number(option("uplink-kbps", PROFILE === "home" ? "4000" : "0"));
const LATENCY_MS = Number(option("latency-ms", PROFILE === "home" ? "30" : "0"));
const SECONDS = Number(option("seconds", "8"));
const TRANSPORT = option("transport", "auto")!;
const ONLY = option("only")?.split(",") ?? null;
const HUB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "http://localhost:3300";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

mkdirSync(join(OUT, "tmp"), { recursive: true });
process.env.TMPDIR = join(OUT, "tmp");
process.env.ENSEMBLE_SECRET_KEY ??= randomBytes(32).toString("base64");
process.env.ENSEMBLE_TAKEOVER_SECONDS ??= "900";

const { createHttpHarness } = await import("../src/test/http.js");
const h = await createHttpHarness();
const { setAskRuntimeStreamForTests } = await import("../src/lib/model-turn.js");
const { settleTurns } = await import("../src/node/queue.js");
const { saveSettings } = await import("../src/lib/settings.js");
const { RunProfile, sealFor, takeoverKeys, sealMessage, openMessage, unpackMessage, channelBase64Url } = await import("@ensemble/shared-types");

/** Pages the node opens: a busy one that keeps changing, and one that flips between two looks on each press. */
const words = "Ensemble Node keeps working while its owner watches the page live from a phone or a laptop. ".repeat(6);
const BUSY = `<!doctype html><html><head><title>Busy</title><style>
body{margin:0;font:15px/1.45 Georgia,serif;background:#fbfaf7;color:#1c1b19}
header{height:120px;background:linear-gradient(120deg,#0b4f6c,#20bf55 60%,#fbb13c)}
main{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;padding:18px}
article{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px}
h2{margin:0 0 6px;font:600 18px system-ui}
.bar{position:fixed;left:0;top:120px;height:8px;background:#e4572e;animation:grow 2s linear infinite}
.tick{position:fixed;right:24px;top:24px;font:700 42px system-ui;color:#fff}
@keyframes grow{from{width:0}to{width:100%}}
</style></head><body><header></header><div class="bar"></div><div class="tick" id="tick">0</div><main>
${Array.from({ length: 12 }, (_, index) => `<article><h2>Section ${index + 1}</h2><p>${words}</p><table>${Array.from({ length: 4 }, (_, row) => `<tr><td>Row ${row}</td><td>${(index * 37 + row * 11) % 97}.${row}%</td><td>€${(index + 3) * (row + 2)}</td></tr>`).join("")}</table></article>`).join("")}
</main><script>let n=0;setInterval(()=>{document.getElementById("tick").textContent=String(++n)},100)</script></body></html>`;
const TOGGLE = `<!doctype html><html><head><title>Toggle</title><style>
html,body{margin:0;height:100%}
body.on{background:repeating-linear-gradient(45deg,#e4572e 0 7px,#29335c 7px 13px,#f3a712 13px 19px,#669bbc 19px 26px)}
body.off{background:#ffffff}
p{font:24px system-ui;margin:24px}
</style></head><body class="off"><p>Press anywhere</p><script>
document.addEventListener("mousedown",()=>{document.body.className=document.body.className==="on"?"off":"on"});
</script></body></html>`;

const site: Server = createServer((request, response) => {
  response.setHeader("content-type", "text/html");
  response.end(request.url === "/toggle" ? TOGGLE : BUSY);
});
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
const SITE = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

await h.app.listen({ port: 0, host: "127.0.0.1" });
const HUB = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;

/**
 * One uplink shared by every byte that crosses it (bits a second), and a one-way delay: chunks leave in
 * order, each when the link has carried it and its delay has passed.
 */
class Uplink {
  private free = 0;
  constructor(private readonly kbps: number) {}
  doneAt(bytes: number, now: number): number {
    if (!this.kbps) return now;
    const start = Math.max(now, this.free);
    this.free = start + (bytes * 8) / this.kbps;
    return this.free;
  }
}
const uplink = new Uplink(UPLINK_KBPS);

/** A TCP proxy to the hub: what goes `up` (to the hub from the computer, or from the hub to the owner) crosses the uplink. */
async function proxy(upToHub: boolean): Promise<string> {
  const target = new URL(HUB);
  const relay = (from: Socket, to: Socket, limited: boolean) => {
    let last = 0;
    from.on("data", (chunk: Buffer) => {
      const now = performance.now();
      let at = Math.max(now + LATENCY_MS, last);
      if (limited) at = Math.max(at, uplink.doneAt(chunk.length, now) + LATENCY_MS);
      last = at;
      setTimeout(() => to.writable && to.write(chunk), Math.max(0, at - now));
    });
    from.on("end", () => setTimeout(() => to.end(), Math.max(0, last - performance.now()) + 1));
    from.on("error", () => to.destroy());
  };
  const server = createTcpServer((client) => {
    const upstream = connect(Number(target.port), target.hostname);
    relay(client, upstream, upToHub);
    relay(upstream, client, !upToHub);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const shaped = PROFILE !== "lan" || UPLINK_KBPS > 0 || LATENCY_MS > 0;
const DEVICE_API = shaped ? await proxy(true) : HUB;
const OWNER_API = shaped ? await proxy(false) : HUB;

type Call = { name: string; arguments: Record<string, unknown> };
let script: (transcript: string) => { calls?: Call[]; then?: string; text?: string } = () => ({ text: "ok" });
setAskRuntimeStreamForTests(async (input) => {
  const messages = input.messages as Array<{ role?: string; content?: unknown }>;
  const last = messages.filter((row) => row.role === "user").at(-1)?.content;
  const transcript = Array.isArray(last) ? last.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(last ?? "");
  const second = messages.at(-1)?.role === "tool";
  const step = script(transcript);
  const calls = second ? [] : (step.calls ?? []);
  const text = second ? (step.then ?? "Done.") : calls.length ? "" : (step.text ?? "ok");
  if (text) input.onDelta?.(text);
  return { text, toolCalls: calls.map((call, index) => ({ id: `call-${randomBytes(4).toString("hex")}-${index}`, name: call.name, arguments: JSON.stringify(call.arguments) })), model: "bench", credits: 0, tokensIn: 1, tokensOut: 1, reasoning: "", raw: {}, finishReason: "stop", cutOff: false };
});

async function http(base: string, path: string, init: { method?: string; body?: unknown; cookie?: string; token?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.cookie) headers.cookie = init.cookie;
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const response = await fetch(`${base}${path}`, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${response.status} ${text.slice(0, 300)}`);
  return { text, json: text ? (JSON.parse(text) as any) : null };
}

/** This checkout's runtime, in a data folder of its own, on a free port, without a screen. */
async function bootComputer() {
  // Short paths: Chromium's socket path must fit in 108 characters.
  const root = mkdtempSync(join(homedir(), ".ensemble-bench-"));
  mkdirSync(join(root, "tmp"), { recursive: true });
  const token = randomBytes(24).toString("base64url");
  const discovery = join(root, "api.json");
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DATABASE_URL;
  delete env.HUB_API_PORT;
  delete env.REDIS_URL;
  delete env.ENSEMBLE_DESKTOP;
  const child = spawn(process.execPath, ["--import", "tsx", "src/desktop/main.ts"], {
    cwd: HUB_DIR,
    env: {
      ...env,
      NODE_ENV: "development",
      DISPLAY: "",
      WAYLAND_DISPLAY: "",
      TMPDIR: join(root, "tmp"),
      HOME: process.env.HOME,
      ENSEMBLE_DATA_DIR: join(root, "pglite"),
      ENSEMBLE_BACKUP_DIR: join(root, "backups"),
      ENSEMBLE_DISCOVERY_FILE: discovery,
      ENSEMBLE_DESKTOP_TOKEN: token,
      ENSEMBLE_WORKSPACE_ROOT: join(root, "workspace"),
      ENSEMBLE_REMOTE_STATE_DIR: join(root, "remote"),
      ENSEMBLE_INPROCESS_RUNTIME: "1",
      ENSEMBLE_RUNTIME_OWNER: "cli",
      REDIS_URL: "memory://desktop",
      HUB_API_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => (logs = (logs + String(chunk)).slice(-400_000)));
  child.stderr.on("data", (chunk) => (logs = (logs + String(chunk)).slice(-400_000)));
  const started = Date.now();
  while (!existsSync(discovery)) {
    if (child.exitCode !== null) throw new Error(`the computer's runtime stopped:\n${logs.slice(-3000)}`);
    if (Date.now() - started > 180_000) throw new Error(`the computer's runtime did not start:\n${logs.slice(-3000)}`);
    await sleep(300);
  }
  const { port } = JSON.parse(readFileSync(discovery, "utf8")) as { port: number };
  return {
    root,
    pid: child.pid,
    logs: () => logs,
    api: (path: string, init: { method?: string; body?: unknown } = {}) => http(`http://127.0.0.1:${port}`, path, { ...init, token }),
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((done) => child.once("exit", done));
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(15_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

type Frame = { at: number; seq: number; wire: number; header: Record<string, unknown>; payload: Buffer };

/** The owner's browser for one live card, over HTTP: frames by long poll or by the stream, input, control. */
async function ownerView(cookie: string, liveCardId: string, transport: string) {
  const created = await http(OWNER_API, "/api/node/takeovers", { cookie, headers: { origin: ORIGIN }, body: { liveCardId } });
  const { takeover, controller } = created.json as { takeover: { id: string; tab: string; computer: { id: string }; sealKey: { kid: string; spki: string } }; controller: string };
  const headers = { origin: ORIGIN, "x-ensemble-takeover": controller };
  const secret = new Uint8Array(randomBytes(32));
  const keys = await takeoverKeys(secret, takeover.id);
  const box = await sealFor(takeover.sealKey as never, { purpose: "takeover", deviceId: takeover.computer.id, decisionId: takeover.id, name: takeover.tab, origin: ORIGIN }, { k: channelBase64Url(secret) }, { ttlMs: 120_000 });
  await http(OWNER_API, `/api/node/takeovers/${takeover.id}/start`, { cookie, headers, body: { sealed: box.sealed } });
  let outSeq = 0;
  let inSeq = 0;
  const frames: Frame[] = [];
  const waiters = new Set<() => void>();
  let stopped = false;
  let used = transport;
  let encoding = "";
  const take = async (message: { seq: number; iv: string; ct: string }, wire: number) => {
    if (message.seq <= inSeq) return;
    inSeq = message.seq;
    const opened = unpackMessage(await openMessage(keys.d2w, takeover.id, "d2w", message));
    frames.push({ at: performance.now(), seq: message.seq, wire, header: opened.header, payload: Buffer.from(opened.payload) });
    for (const wake of waiters) wake();
  };
  const abort = new AbortController();
  const poll = async () => {
    while (!stopped) {
      const response = await fetch(`${OWNER_API}/api/node/takeovers/${takeover.id}/frames?after=${inSeq}`, { headers: { ...headers, cookie }, signal: abort.signal }).catch(() => null);
      if (!response) return;
      const text = await response.text();
      const body = JSON.parse(text) as { state: string; frame: { seq: number; iv: string; ct: string } | null };
      if (body.state === "ended") return;
      if (body.frame) await take(body.frame, text.length);
    }
  };
  const stream = async (): Promise<boolean> => {
    const response = await fetch(`${OWNER_API}/api/node/takeovers/${takeover.id}/stream?after=${inSeq}`, { headers: { ...headers, cookie, accept: "text/event-stream" }, signal: abort.signal }).catch(() => null);
    if (!response?.ok || !response.body || !/event-stream/.test(response.headers.get("content-type") ?? "")) return false;
    encoding = response.headers.get("content-encoding") ?? "identity";
    used = "stream";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done) return true;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        const event = /^event:\s*(\S+)/m.exec(block)?.[1] ?? "message";
        if (!data) continue;
        if (event === "frame") {
          const message = JSON.parse(data) as { seq: number; iv: string; ct: string };
          await take(message, data.length);
          // Drawn: the stream may send the next (as the Node page says it).
          void http(OWNER_API, `/api/node/takeovers/${takeover.id}/seen`, { cookie, headers, body: { seq: message.seq } }).catch(() => undefined);
        }
        if (event === "end") return true;
      }
    }
  };
  void (async () => {
    if (transport !== "poll" && (await stream())) {
      used = "stream";
      return;
    }
    used = "poll";
    await poll();
  })();
  const view = {
    id: takeover.id,
    frames,
    get transport() {
      return encoding ? `${used} (${encoding})` : used;
    },
    async next(after: number, ms = 10_000): Promise<Frame | null> {
      const deadline = performance.now() + ms;
      for (;;) {
        const found = frames.find((frame) => frame.at > after);
        if (found) return found;
        if (performance.now() >= deadline) return null;
        await new Promise<void>((done) => {
          const wake = () => {
            waiters.delete(wake);
            clearTimeout(timer);
            done();
          };
          const timer = setTimeout(wake, Math.max(1, deadline - performance.now()));
          waiters.add(wake);
        });
      }
    },
    async send(events: unknown[]) {
      outSeq += 1;
      const message = await sealMessage(keys.w2d, takeover.id, "w2d", outSeq, new TextEncoder().encode(JSON.stringify({ events })));
      await http(OWNER_API, `/api/node/takeovers/${takeover.id}/input`, { cookie, headers, body: message });
    },
    control: (on: boolean) => http(OWNER_API, `/api/node/takeovers/${takeover.id}/control`, { cookie, headers, body: { on } }),
    async end() {
      stopped = true;
      await http(OWNER_API, `/api/node/takeovers/${takeover.id}/end`, { cookie, headers, body: { done: false } }).catch(() => undefined);
      abort.abort();
    },
  };
  return view;
}

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};
const p90 = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!;
};
const kb = (bytes: number) => Math.round(bytes / 102.4) / 10;

/** A JPEG's own width, from its frame header. */
function jpegWidth(bytes: Buffer): number | undefined {
  for (let at = 2; at + 9 < bytes.length; ) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1]!;
    const length = bytes.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return bytes.readUInt16BE(at + 7);
    at += 2 + length;
  }
  return undefined;
}

/** Frames a second and bytes a frame over `seconds`, from the first frame after `from`. */
function rate(frames: Frame[], from: number, seconds: number) {
  const window = frames.filter((frame) => frame.at > from && frame.at <= from + seconds * 1000);
  const span = window.length > 1 ? (window.at(-1)!.at - window[0]!.at) / 1000 : seconds;
  return {
    frames: window.length,
    fps: Math.round(((window.length - 1) / Math.max(span, 0.001)) * 10) / 10,
    payloadKB: kb(median(window.map((frame) => frame.payload.length))),
    wireKB: kb(median(window.map((frame) => frame.wire))),
    imageWidth: median(window.map((frame) => (frame.header.kind === "terminal" ? 0 : (jpegWidth(frame.payload) ?? 0)))) || undefined,
  };
}

const results: Record<string, unknown> = { profile: PROFILE, uplinkKbps: UPLINK_KBPS, latencyMs: LATENCY_MS, seconds: SECONDS };
const computer = await bootComputer();
try {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name: "Mira", emailVerifiedAt: new Date() } });
  const { code } = (await http(HUB, "/api/devices/pair", { cookie: user.cookie, body: {} })).json as { code: string };
  await computer.api("/api/remote/pair", { method: "POST", body: { apiBase: DEVICE_API, code, name: "Bench computer" } });
  await computer.api("/api/remote", { method: "PUT", body: { enabled: true, acceptWebApprovals: true } });
  let device: { id: string } | null = null;
  for (let tries = 0; tries < 120 && !device; tries += 1) {
    device = await h.prisma.device.findFirst({ where: { userId: user.id, revokedAt: null, lastSeenAt: { gte: new Date(Date.now() - 60_000) } }, select: { id: true } });
    const caps = device ? ((await h.prisma.device.findUnique({ where: { id: device.id } }))?.capabilities as { takeover?: number; sealKey?: unknown } | null) : null;
    if (!caps?.takeover || !caps.sealKey) device = null;
    if (!device) await sleep(1000);
  }
  if (!device) throw new Error(`the computer did not come online:\n${computer.logs().slice(-3000)}`);
  await saveSettings(h.prisma, user.id, { runProfiles: [RunProfile.parse({ id: "main", name: "Main", engine: "claude-code", mode: "unattended", delivery: "local", deviceId: device.id })], defaultRunProfileId: "main" });
  const created = (await user.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } })).json() as { node: { id: string }; room: { id: string } };
  const messages = async () => (await user.inject({ method: "GET", url: `/api/node/rooms/${created.room.id}/messages` })).json().messages as Array<{ id: string; kind: string; authorNodeId: string | null; data: Record<string, any> }>;
  const say = async (body: string) => {
    const posted = await user.inject({ method: "POST", url: `/api/node/rooms/${created.room.id}/messages`, payload: { body } });
    if (posted.statusCode !== 201) throw new Error(`message: ${posted.statusCode} ${posted.body}`);
    await settleTurns();
    return ((await messages()).filter((row) => row.authorNodeId && row.data?.tools).at(-1)?.data.tools ?? []) as Array<{ name: string; state: string; summary: string | null }>;
  };
  /** The computer asks once for this computer's own addresses: always allowed here. */
  const allow = async () => {
    for (const card of (await messages()).filter((row) => row.kind === "approval" && row.data?.type === "computer" && row.data?.status === "pending")) {
      const option = ((card.data.options ?? []) as string[]).find((label) => /^Always/.test(label)) ?? "Once";
      await user.inject({ method: "POST", url: `/api/decisions/${card.data.decisionId}/decide`, payload: { decision: "allow", scope: "once", reason: option } });
    }
    await settleTurns();
  };
  const tabs: Record<string, string> = {};
  for (const name of ["busy", "toggle"]) {
    const url = `${SITE}/${name === "toggle" ? "toggle" : "busy"}`;
    script = (transcript) => (transcript.includes(`open ${name}`) ? { calls: [{ name: "browser_open", arguments: { url } }], then: "Open." } : { text: "ok" });
    let tools = await say(`open ${name}`);
    if (!tools.some((tool) => tool.name === "browser_open" && tool.state === "ok")) {
      await allow();
      tools = await say(`open ${name}`);
    }
    const summary = tools.find((tool) => tool.name === "browser_open")?.summary ?? "";
    const tab = /Opened (t\d+)/.exec(summary)?.[1];
    if (!tab) throw new Error(`the node did not open ${name}: ${JSON.stringify(tools)}\n${computer.logs().slice(-2000)}`);
    tabs[name] = tab;
    script = (transcript) => (transcript.includes(`watch ${tab}`) ? { calls: [{ name: "live_view", arguments: { kind: "browser", tab } }], then: "There." } : { text: "ok" });
    await say(`watch ${tab}`);
  }
  const cards = (await messages()).filter((row) => row.data?.type === "live");
  const cardOf = (tab: string) => cards.find((row) => row.data.tab === tab)!.id;
  const want = (name: string) => !ONLY || ONLY.includes(name);

  if (want("watch")) {
    const view = await ownerView(user.cookie, cardOf(tabs.busy!), TRANSPORT);
    await view.next(0, 20_000);
    await sleep(1500);
    const from = performance.now();
    await sleep(SECONDS * 1000);
    results.watch = { transport: view.transport, ...rate(view.frames, from, SECONDS) };
    await view.control(true);
    await sleep(1500);
    const controlFrom = performance.now();
    await sleep(SECONDS * 1000);
    results.controlBusy = rate(view.frames, controlFrom, SECONDS);
    await view.end();
    console.log("watch", results.watch, "control (busy page)", results.controlBusy);
  }

  if (want("control")) {
    const view = await ownerView(user.cookie, cardOf(tabs.toggle!), TRANSPORT);
    await view.control(true);
    await view.next(0, 20_000);
    await sleep(1000);
    const latencies: number[] = [];
    const sizes: number[] = [];
    for (let press = 0; press < 12; press += 1) {
      const before = view.frames.at(-1)!;
      const sent = performance.now();
      const point = { x: 0.3 + (press % 4) * 0.1, y: 0.5 };
      await view.send([{ t: "mouse", type: "move", ...point }, { t: "mouse", type: "down", ...point, button: "left", clicks: 1 }, { t: "mouse", type: "up", ...point, button: "left", clicks: 1 }]);
      // The first frame after the press whose size moved far from the one before (the page flipped).
      let shown: Frame | null = null;
      for (let after = sent; !shown; ) {
        const next = await view.next(after, 8_000);
        if (!next) break;
        after = next.at;
        if (Math.abs(next.payload.length - before.payload.length) > Math.max(before.payload.length, next.payload.length) * 0.3) shown = next;
      }
      if (shown) {
        latencies.push(shown.at - sent);
        sizes.push(shown.payload.length);
      }
      await sleep(800);
    }
    results.control = { transport: view.transport, presses: 12, seen: latencies.length, latencyMs: Math.round(median(latencies)), latencyP90Ms: Math.round(p90(latencies)), payloadKB: kb(median(sizes)), imageWidth: jpegWidth(view.frames.at(-1)!.payload) };
    await view.end();
    console.log("control (press → frame)", results.control);
  }

  if (want("terminal")) {
    script = (transcript) => (transcript.includes("terminal please") ? { calls: [{ name: "terminal_open", arguments: { live: true, title: "bench" } }], then: "Open." } : { text: "ok" });
    let tools = await say("terminal please");
    if (!tools.some((tool) => tool.name === "terminal_open" && tool.state === "ok")) {
      await allow();
      tools = await say("terminal please");
    }
    const card = (await messages()).filter((row) => row.data?.type === "live" && row.data.kind === "terminal").at(-1);
    if (!card) throw new Error(`no terminal card: ${JSON.stringify(tools)}\n${computer.logs().slice(-2000)}`);
    const view = await ownerView(user.cookie, card.id, TRANSPORT);
    await view.next(0, 20_000);
    await sleep(800);
    const text = (frame: Frame) => (JSON.parse(frame.payload.toString("utf8")) as { rows: Array<Array<{ t: string }>> }).rows.map((row) => row.map((run) => run.t).join("")).join("\n");
    const latencies: number[] = [];
    for (let key = 0; key < 12; key += 1) {
      const mark = `q${randomBytes(3).toString("hex")}`;
      const sent = performance.now();
      await view.send([{ t: "tty", text: mark }]);
      let shown: Frame | null = null;
      for (let after = sent; !shown; ) {
        const next = await view.next(after, 8_000);
        if (!next) break;
        after = next.at;
        if (text(next).includes(mark)) shown = next;
      }
      if (shown) latencies.push(shown.at - sent);
      await view.send([{ t: "tty-key", key: "Ctrl+U" }]);
      await sleep(400);
    }
    await view.send([{ t: "tty", text: "for i in $(seq 1 100000); do echo \"line $i $RANDOM $RANDOM $RANDOM\"; sleep 0.005; done\r" }]);
    await sleep(1500);
    const from = performance.now();
    await sleep(SECONDS * 1000);
    results.terminal = { transport: view.transport, latencyMs: Math.round(median(latencies)), latencyP90Ms: Math.round(p90(latencies)), seen: latencies.length, ...rate(view.frames, from, SECONDS) };
    await view.send([{ t: "tty-key", key: "Ctrl+C" }]);
    await view.end();
    console.log("terminal", results.terminal);
  }
} finally {
  writeFileSync(join(OUT, `bench-${PROFILE}-${Date.now().toString(36)}.json`), JSON.stringify(results, null, 2));
  writeFileSync(join(OUT, "computer.log"), computer.logs());
  await computer.stop();
  await h.app.close().catch(() => undefined);
  site.close();
  rmSync(computer.root, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 2));
process.exit(0);
