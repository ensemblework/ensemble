import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { agentAppNotes, localComputer } from "./agent-apps.js";

const CLAUDE = { id: "claude-code", via: "app", version: "2.1.300", signedIn: true, plan: "max", models: [], checkedAt: "2026-11-15T09:00:00.000Z" };
const CURSOR = { id: "cursor-agent", via: "cli", version: "2026.11.13", signedIn: false, plan: null, models: [], checkedAt: "2026-11-15T09:00:00.000Z" };

test("doctor notes an agent's app that is here without its agent, with the vendor's install command for this system", () => {
  const homeserver = { local: true, agents: [CLAUDE], apps: ["cursor-app", "vscode-copilot"] };
  assert.deepEqual(agentAppNotes(homeserver, "linux"), [
    { label: "Cursor app found. Set up its agent", fix: "press Set up under Settings → Models, or run `curl https://cursor.com/install -fsS | bash`, then `cursor-agent login`" },
    { label: "VS Code found. Set up Copilot CLI", fix: "press Set up under Settings → Models, or run `curl -fsSL https://gh.io/copilot-install | bash`, then `copilot login`" },
  ]);
  assert.deepEqual(
    agentAppNotes(homeserver, "win32").map((note) => note.fix),
    [
      "press Set up under Settings → Models, or run `irm 'https://cursor.com/install?win32=true' | iex`, then `cursor-agent login`",
      "press Set up under Settings → Models, or run `winget install GitHub.Copilot`, then `copilot login`",
    ],
  );
  assert.deepEqual(agentAppNotes({ ...homeserver, agents: [CLAUDE, CURSOR] }, "darwin").map((note) => note.label), ["VS Code found. Set up Copilot CLI"], "with the agent there, nothing to set up");
  assert.deepEqual(agentAppNotes({ local: true, agents: [CLAUDE] }, "linux"), [], "an older runtime reports no apps");
  assert.deepEqual(agentAppNotes(null, "linux"), []);
  for (const note of agentAppNotes(homeserver, "linux")) assert.doesNotMatch(`${note.label}: ${note.fix}`, /—/);
});

test("doctor reads this computer from the runtime, and says nothing when the runtime does not answer in time", async () => {
  let answer: unknown = { computers: [{ id: "local", local: true, agents: [CLAUDE], apps: ["cursor-app"] }], preferred: null };
  let slow = false;
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url} ${request.headers.authorization}`);
    const send = () => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    if (slow) setTimeout(send, 400);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const runner = { port: (server.address() as AddressInfo).port, token: "local-token" };
    assert.deepEqual(agentAppNotes(await localComputer(runner)).map((note) => note.label), ["Cursor app found. Set up its agent"]);
    assert.deepEqual(seen, ["GET /api/subscriptions Bearer local-token"]);
    answer = { computers: [{ id: "device-1", local: false, agents: [], apps: ["cursor-app"] }] };
    assert.equal(await localComputer(runner), null, "only this computer counts");
    slow = true;
    assert.equal(await localComputer(runner, 50), null);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
