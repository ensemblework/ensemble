import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APP_IDS } from "./catalog";
import {
  claudeCodeCommand,
  claudeDesktopConfig,
  clineConfig,
  codexCommand,
  codexToml,
  continueYaml,
  copilotCliConfig,
  cursorConfig,
  cursorInstallUrl,
  envCommand,
  httpClineConfig,
  httpMcpConfig,
  httpVsCodeConfig,
  jetbrainsConfig,
  connectHubUrl,
  TOKEN_PLACEHOLDER,
  utf8Base64,
  vscodeCliCommand,
  vscodeInstallUrl,
  vscodeUserConfig,
  windsurfConfig,
  zedSnippet,
  type ConnectFacts,
} from "./configs";
import { stepsFor, troubleFor } from "./guides";

const SECRET = "ens_test_key_not_a_real_secret_value";

const facts: ConnectFacts = {
  repoRoot: "/work/ensemble",
  bridgeScript: "/work/ensemble/apps/context-bridge/dist/index.js",
  node: "/usr/bin/node",
  hubApiUrl: "http://127.0.0.1:4000",
  httpUrl: "http://127.0.0.1:4010/mcp",
  token: SECRET,
};

const bare: ConnectFacts = { ...facts, token: null };

describe("connect configs match the bridge samples", () => {
  it("fills VS Code user settings with servers, stdio, and an env key reference", () => {
    const parsed = JSON.parse(vscodeUserConfig(facts)) as {
      servers: { ensemble: { type: string; command: string; args: string[]; env: Record<string, string> } };
    };
    assert.equal(parsed.servers.ensemble.type, "stdio");
    assert.equal(parsed.servers.ensemble.command, "node");
    assert.deepEqual(parsed.servers.ensemble.args, [facts.bridgeScript]);
    assert.equal(parsed.servers.ensemble.env.HUB_API_URL, facts.hubApiUrl);
    assert.equal(parsed.servers.ensemble.env.ENSEMBLE_BRIDGE_TOKEN, "${env:ENSEMBLE_BRIDGE_TOKEN}");
    assert.equal(vscodeUserConfig(facts).includes(SECRET), false);
  });

  it("builds the official VS Code install link without the key", () => {
    const url = vscodeInstallUrl(facts);
    assert.ok(url.startsWith("vscode:mcp/install?"));
    const payload = JSON.parse(decodeURIComponent(url.slice("vscode:mcp/install?".length))) as {
      name: string;
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    assert.equal(payload.name, "ensemble");
    assert.equal(payload.command, "node");
    assert.deepEqual(payload.args, [facts.bridgeScript]);
    assert.equal(payload.env.ENSEMBLE_BRIDGE_TOKEN, "${env:ENSEMBLE_BRIDGE_TOKEN}");
    assert.equal(url.includes(SECRET), false);
    assert.ok(vscodeInstallUrl(facts, true).startsWith("vscode-insiders:mcp/install?"));
    assert.match(vscodeCliCommand(facts, "mac"), /^code --add-mcp /);
  });

  it("builds the official Cursor install link from the server object", () => {
    const url = cursorInstallUrl(facts);
    const parsed = new URL(url);
    assert.equal(parsed.protocol, "cursor:");
    assert.equal(parsed.hostname, "anysphere.cursor-deeplink");
    assert.equal(parsed.pathname, "/mcp/install");
    assert.equal(parsed.searchParams.get("name"), "ensemble");
    const config = JSON.parse(Buffer.from(parsed.searchParams.get("config")!, "base64").toString("utf8")) as {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    assert.equal(config.command, "node");
    assert.deepEqual(config.args, [facts.bridgeScript]);
    assert.equal(config.env.ENSEMBLE_BRIDGE_TOKEN, "${env:ENSEMBLE_BRIDGE_TOKEN}");
    assert.equal(url.includes(SECRET), false);
    assert.equal(utf8Base64("hi"), Buffer.from("hi").toString("base64"));
    const file = JSON.parse(cursorConfig(facts)) as { mcpServers: { ensemble: { args: string[] } } };
    assert.deepEqual(file.mcpServers.ensemble.args, [facts.bridgeScript]);
  });

  it("puts the real key in clients that store a literal token", () => {
    for (const text of [
      copilotCliConfig(facts),
      claudeDesktopConfig(facts),
      windsurfConfig(facts),
      zedSnippet(facts),
      jetbrainsConfig(facts),
      clineConfig(facts),
      continueYaml(facts),
      codexToml(facts),
      claudeCodeCommand(facts, "linux"),
      codexCommand(facts, "mac"),
    ]) {
      assert.equal(text.includes(SECRET), true, text.slice(0, 80));
      assert.equal(text.includes(facts.bridgeScript) || text.includes(facts.bridgeScript.replace(/\\/g, "\\\\")), true);
    }
    const copilot = JSON.parse(copilotCliConfig(facts)) as { mcpServers: { ensemble: { type: string; tools: string[] } } };
    assert.equal(copilot.mcpServers.ensemble.type, "local");
    assert.deepEqual(copilot.mcpServers.ensemble.tools, ["*"]);
    const cline = JSON.parse(clineConfig(facts)) as { mcpServers: { ensemble: { type?: string; command: string } } };
    assert.equal(cline.mcpServers.ensemble.type, undefined);
    assert.equal(cline.mcpServers.ensemble.command, "node");
    const zed = JSON.parse(zedSnippet(facts)) as { context_servers: { ensemble: { command: string; args: string[] } } };
    assert.equal(zed.context_servers.ensemble.command, "node");
    assert.deepEqual(zed.context_servers.ensemble.args, [facts.bridgeScript]);
    assert.match(codexToml(facts), /\[mcp_servers\.ensemble\]/);
    assert.match(codexToml(facts), /\[mcp_servers\.ensemble\.env\]/);
    assert.match(claudeCodeCommand(facts, "linux"), /claude mcp add --transport stdio/);
    assert.match(codexCommand(facts, "linux"), /^codex mcp add ensemble --env /);
  });

  it("uses the placeholder until a key exists, and switches shell syntax by OS", () => {
    assert.equal(claudeDesktopConfig(bare).includes(TOKEN_PLACEHOLDER), true);
    assert.equal(envCommand(facts, "mac"), `export ENSEMBLE_BRIDGE_TOKEN="${SECRET}"`);
    assert.equal(envCommand(facts, "windows"), `$env:ENSEMBLE_BRIDGE_TOKEN = "${SECRET}"`);
    assert.match(claudeCodeCommand(facts, "windows"), /^claude mcp add --transport stdio --env /);
    assert.doesNotMatch(claudeCodeCommand(facts, "windows"), /\\$/m);
  });

  it("describes the shared HTTP endpoint the way each family expects", () => {
    const vscode = JSON.parse(httpVsCodeConfig(facts)) as { servers: { ensemble: { type: string; url: string } } };
    assert.equal(vscode.servers.ensemble.type, "http");
    assert.equal(vscode.servers.ensemble.url, facts.httpUrl);
    const others = JSON.parse(httpMcpConfig(facts)) as { mcpServers: { ensemble: { type: string; url: string } } };
    assert.equal(others.mcpServers.ensemble.type, "http");
    assert.equal(others.mcpServers.ensemble.url, facts.httpUrl);
    const cline = JSON.parse(httpClineConfig(facts)) as { mcpServers: { ensemble: { type: string } } };
    assert.equal(cline.mcpServers.ensemble.type, "streamableHttp");
  });
});

describe("connect hub url", () => {
  it("uses the public URL for hosted users and the loopback address otherwise", () => {
    assert.equal(
      connectHubUrl({ hubApiUrl: "http://127.0.0.1:4000", publicApiUrl: "https://hub.example" }),
      "https://hub.example",
    );
    assert.equal(
      connectHubUrl({ hubApiUrl: "http://127.0.0.1:4000", publicApiUrl: "https://hub.example/" }),
      "https://hub.example",
    );
    assert.equal(
      connectHubUrl({ hubApiUrl: "http://127.0.0.1:4000", publicApiUrl: "http://localhost:4000" }),
      "http://127.0.0.1:4000",
    );
    assert.equal(
      connectHubUrl({ hubApiUrl: "http://127.0.0.1:4000", publicApiUrl: "http://127.0.0.1:4000" }),
      "http://127.0.0.1:4000",
    );
    assert.equal(connectHubUrl({ hubApiUrl: "http://127.0.0.1:4000", publicApiUrl: "" }), "http://127.0.0.1:4000");
    assert.equal(connectHubUrl({}), "http://127.0.0.1:4000");
  });
});

describe("guides", () => {
  it("gives every app a key step, a test, and plain-language troubleshooting", () => {
    for (const id of APP_IDS) {
      const ready = stepsFor(id, true);
      assert.equal(ready[0]?.kind, "key");
      assert.equal(ready.at(-1)?.kind, "test");
      assert.equal(ready.some((step) => step.kind === "build"), false);
      const fresh = stepsFor(id, false);
      assert.equal(fresh[1]?.kind, "build");
      assert.ok(troubleFor(id).length >= 3);
      for (const step of ready) {
        assert.ok(step.title.length > 0);
        assert.ok(step.body.length > 40);
      }
    }
    assert.equal(stepsFor("http", true).at(-1)?.requiresHttp, true);
    assert.equal(stepsFor("vscode", true).at(-1)?.requiresHttp, undefined);
  });
});
