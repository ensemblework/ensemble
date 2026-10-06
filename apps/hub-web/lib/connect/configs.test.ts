import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APP_IDS } from "./catalog";
import {
  EDITORS,
  HOSTED_MCP_FALLBACK_URL,
  INSTALL_CHANNELS,
  TOKEN_PLACEHOLDER,
  connectHubUrl,
  cursorInstallUrl,
  hostedMcpUrl,
  hostedSnippet,
  localCliSnippet,
  setupOneLiner,
  utf8Base64,
  vscodeInstallUrl,
  type ConnectFacts,
  type ConnectOs,
  type ConnectSnippet,
} from "./configs";
import { stepsFor, troubleFor } from "./guides";

const SECRET = "ens_test_key_not_a_real_secret_value";
const OS: ConnectOs[] = ["mac", "windows", "linux"];

const facts: ConnectFacts = {
  repoRoot: "/work/ensemble",
  bridgeScript: "/work/ensemble/apps/context-bridge/dist/index.js",
  node: "/usr/bin/node",
  hubApiUrl: "http://127.0.0.1:4000",
  publicApiUrl: "https://api.example.com",
  httpUrl: "http://127.0.0.1:4010/mcp",
  token: SECRET,
};

function parseJson(snippet: ConnectSnippet): unknown {
  assert.equal(snippet.format, "json");
  return JSON.parse(snippet.text);
}

function assertToml(text: string) {
  assert.match(text, /^\[mcp_servers\.ensemble\]/m);
  for (const line of text.split("\n").filter(Boolean)) {
    if (line.startsWith("[")) continue;
    assert.match(line, /^[a-z_]+ = (".*"|\[.*\])$/);
  }
}

function assertSnippetSyntax(snippet: ConnectSnippet) {
  if (snippet.format === "json") JSON.parse(snippet.text);
  if (snippet.format === "toml") assertToml(snippet.text);
  if (snippet.format === "yaml") assert.match(snippet.text, /mcpServers:/);
}

function serverObject(value: unknown): Record<string, unknown> {
  const root = value as Record<string, unknown>;
  if ("servers" in root) return ((root.servers as Record<string, unknown>).ensemble ?? {}) as Record<string, unknown>;
  if ("mcpServers" in root) return ((root.mcpServers as Record<string, unknown>).ensemble ?? {}) as Record<string, unknown>;
  if ("context_servers" in root) return ((root.context_servers as Record<string, unknown>).ensemble ?? {}) as Record<string, unknown>;
  if ("mcp" in root) return ((root.mcp as Record<string, unknown>).ensemble ?? {}) as Record<string, unknown>;
  return root;
}

describe("CLI install commands", () => {
  it("uses the contracted install commands and coming-soon flags", () => {
    assert.equal(INSTALL_CHANNELS.mac[0]?.commands[0], "brew install ensemblework/tap/ensemble");
    assert.ok(INSTALL_CHANNELS.mac.some((row) => row.commands.includes("curl -fsSL https://ensemblework.com/install.sh | sh")));
    assert.ok(INSTALL_CHANNELS.windows.some((row) => row.commands.includes("irm https://ensemblework.com/install.ps1 | iex")));
    assert.ok(INSTALL_CHANNELS.windows.some((row) => row.commands.includes("scoop bucket add ensemblework https://github.com/ensemblework/scoop-bucket")));
    const winget = INSTALL_CHANNELS.windows.find((row) => row.id === "winget");
    assert.equal(winget?.commands[0], "winget install EnsembleWork.EnsembleCLI");
    assert.equal(winget?.status, "coming-soon");
    assert.ok(INSTALL_CHANNELS.linux.some((row) => row.commands.includes("sudo apt install ./ensemble-cli_*_amd64.deb")));
    assert.ok(INSTALL_CHANNELS.linux.some((row) => row.commands.includes("sudo dnf install ./ensemble-cli-*.x86_64.rpm")));
    assert.equal(INSTALL_CHANNELS.linux.find((row) => row.id === "aur")?.status, "coming-soon");
    for (const os of OS) {
      const npm = INSTALL_CHANNELS[os].find((row) => row.id === "npm");
      assert.equal(npm?.status, "coming-soon");
      assert.deepEqual(npm?.commands, ["npm install -g ensemblework", "npx -y ensemblework mcp"]);
    }
  });
});

describe("connect URL helpers", () => {
  it("uses public API URLs for hosted MCP and loopback for local bridge setup", () => {
    assert.equal(connectHubUrl({ hubApiUrl: "http://127.0.0.1:4000", publicApiUrl: "https://hub.example/" }), "https://hub.example");
    assert.equal(connectHubUrl({ hubApiUrl: "http://127.0.0.1:4000", publicApiUrl: "http://localhost:4000" }), "http://127.0.0.1:4000");
    assert.equal(hostedMcpUrl({ publicApiUrl: "https://api.example.com/" }), "https://api.example.com/mcp");
    assert.equal(hostedMcpUrl({ origin: "https://app.ensemblework.com" }), "https://api.ensemblework.com/mcp");
    assert.equal(hostedMcpUrl({}), HOSTED_MCP_FALLBACK_URL);
  });
});

describe("editor snippets", () => {
  it("has one setup id and one-liner for every catalog entry", () => {
    for (const id of APP_IDS) {
      assert.equal(EDITORS[id].id, id);
      assert.match(setupOneLiner(id), new RegExp(`ensemble mcp setup ${EDITORS[id].setupId}`));
    }
  });

  it("generates a valid CLI-local snippet for every editor and OS", () => {
    for (const id of APP_IDS) {
      for (const os of OS) {
        const snippet = localCliSnippet(id, os);
        assertSnippetSyntax(snippet);
        if (snippet.format === "json") {
          const server = serverObject(parseJson(snippet));
          if (id === "opencode") assert.deepEqual(server.command, ["ensemble", "mcp"]);
          else {
            if (id === "claude-desktop") assert.notEqual(server.command, "ensemble");
            else assert.equal(server.command, "ensemble");
            assert.deepEqual(server.args, ["mcp"]);
          }
          if (id === "copilot-cli") assert.deepEqual(server.tools, ["*"]);
          if (id === "cline") assert.equal(server.disabled, false);
        }
        if (snippet.format === "toml") {
          assert.match(snippet.text, /command = "ensemble"/);
          assert.match(snippet.text, /args = \["mcp"\]/);
        }
        if (snippet.format === "shell") assert.match(snippet.text, /ensemble mcp/);
      }
    }
  });

  it("generates a valid hosted snippet for every editor and OS", () => {
    for (const id of APP_IDS) {
      for (const os of OS) {
        const snippet = hostedSnippet(id, facts, os, "https://app.ensemblework.com");
        assertSnippetSyntax(snippet);
        if (!EDITORS[id].supportsHosted) {
          assert.match(snippet.text, /not supported|CLI local server/i);
          continue;
        }
        assert.match(`${snippet.text}\n${snippet.note ?? ""}`, /https:\/\/api\.example\.com\/mcp/);
        if (snippet.format === "json") {
          const parsed = parseJson(snippet);
          {
            const server = serverObject(parsed);
            assert.equal((server.headers as Record<string, string>).Authorization, `Bearer ${SECRET}`);
            if (id === "cline") assert.equal(server.type, "streamableHttp");
            if (id === "copilot-cli") assert.deepEqual(server.tools, ["*"]);
          }
        }
        if (snippet.format === "toml") {
          assert.match(snippet.text, /bearer_token_env_var = "ENSEMBLE_TOKEN"/);
          assert.match(snippet.note ?? "", new RegExp(SECRET));
        }
        if (snippet.format === "yaml") assert.match(snippet.text, new RegExp(SECRET));
      }
    }
  });

  it("uses placeholders until a hosted key exists", () => {
    const bare = { ...facts, token: null };
    const cursor = hostedSnippet("cursor", bare, "mac");
    assert.match(cursor.text, /Bearer KEY/);
    const local = localCliSnippet("vscode", "linux");
    assert.equal(local.text.includes(TOKEN_PLACEHOLDER), false);
  });
});

describe("developer source helpers", () => {
  it("keeps official install links keyless", () => {
    const vsCode = vscodeInstallUrl(facts);
    assert.ok(vsCode.startsWith("vscode:mcp/install?"));
    assert.equal(vsCode.includes(SECRET), false);
    assert.ok(vscodeInstallUrl(facts, true).startsWith("vscode-insiders:mcp/install?"));
    const cursor = cursorInstallUrl(facts);
    const parsed = new URL(cursor);
    assert.equal(parsed.protocol, "cursor:");
    assert.equal(utf8Base64("hi"), Buffer.from("hi").toString("base64"));
  });
});

describe("guides", () => {
  it("gives every app a key step, a test, and troubleshooting", () => {
    for (const id of APP_IDS) {
      const ready = stepsFor(id, true);
      assert.equal(ready[0]?.kind, "key");
      assert.equal(ready.at(-1)?.kind, "test");
      const fresh = stepsFor(id, false);
      assert.equal(fresh[1]?.kind, "build");
      assert.ok(troubleFor(id).length >= 3);
      for (const step of ready) {
        assert.ok(step.title.length > 0);
        assert.ok(step.body.length > 40);
      }
    }
  });
});
