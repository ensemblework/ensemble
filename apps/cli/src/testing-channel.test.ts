import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("testing builds isolate auth, runtime paths, services, editors, migrations and updates", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ensemble-testing-channel-"));
  const outfile = join(temp, "probe.mjs");
  try {
    await build({
      stdin: {
        resolveDir: resolve("src"),
        contents: `
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveCliPaths, resolveConfigDir, resolveDataHome } from "./paths";
import { loadConfig, loadToken, saveConfig, normalizeApiBase } from "./config";
import { launchAgentPlist, systemdUserUnit, windowsTaskCreateCommand } from "./services";
import { setupEditor, removeEditor } from "./editors";
import { migrateLegacyData } from "./migrate";
import { startDeviceFlow } from "./auth-flow";
import { dailyUpdateNotice, compareVersions, detectInstallMethod } from "./update";
import { nodeWebUrl } from "./tui/node";
const temp = process.argv[2];
process.env.ENSEMBLE_TOKEN = "production-secret";
process.env.ENSEMBLE_BRIDGE_TOKEN = "production-bridge-secret";
process.env.ENSEMBLE_API_URL = "https://api.ensemblework.com";
const env = { ENSEMBLE_CONFIG_DIR: "/production/config", ENSEMBLE_DATA_HOME: "/production/data" };
assert.match(resolveConfigDir({ platform: "linux", home: temp, env }), /ensemble-test$/);
for (const platform of ["linux", "darwin", "win32"]) assert.match(resolveDataHome({ platform, home: temp, env }), /com\\.ensemblework\\.cli\\.testing$/);
const paths = resolveCliPaths({ platform: "linux", home: temp, env });
assert.equal((await loadConfig(paths)).apiBase, "https://api-test.ensemblework.com");
assert.equal(await loadToken(paths), null);
process.env.ENSEMBLE_TEST_TOKEN = "testing-secret";
assert.equal(await loadToken(paths), "testing-secret");
assert.throws(() => normalizeApiBase("https://api.ensemblework.com"), /only/);
assert.throws(() => normalizeApiBase("https://api-test.ensemblework.com.evil.test"), /only/);
assert.throws(() => normalizeApiBase("https://api-test.ensemblework.com/other"), /only/);
await assert.rejects(() => saveConfig({ apiBase: "https://api.ensemblework.com", appUrl: "https://app.ensemblework.com" }, paths), /only/);
await assert.rejects(() => startDeviceFlow({ apiBase: "https://api.ensemblework.com", clientName: "test", platform: "linux", scopes: ["mcp"], fetchImpl: () => { throw Error("must not send"); } }), /only/);
assert.equal((await migrateLegacyData(paths, { legacy: "/production/data" })).status, "none");
assert.match(launchAgentPlist({ launcher: "/bin/ensemble-test", logPath: "/tmp/test.log" }), /com\\.ensemblework\\.cli\\.testing\\.runner/);
assert.match(systemdUserUnit({ launcher: "/bin/ensemble-test", logPath: "/tmp/test.log" }), /Testing Runner/);
assert.equal(windowsTaskCreateCommand("ensemble-test.exe")[2], "Ensemble Testing Runner");
const vscode = join(temp, ".config/Code/User/mcp.json");
await mkdir(join(temp, ".config/Code/User"), { recursive: true });
await writeFile(vscode, JSON.stringify({ servers: { ensemble: { command: "production" } } }));
const mode = { hosted: false, apiBase: "https://api-test.ensemblework.com", token: null, launcher: { command: "/bin/ensemble-test", argsPrefix: [], source: "argv" } };
await setupEditor("vscode", mode, { platform: "linux", home: temp, env: {} });
let servers = JSON.parse(await readFile(vscode, "utf8")).servers;
assert.equal(servers.ensemble.command, "production");
assert.equal(servers["ensemble-test"].command, "/bin/ensemble-test");
await removeEditor("vscode", { platform: "linux", home: temp, env: {} });
servers = JSON.parse(await readFile(vscode, "utf8")).servers;
assert.equal(servers.ensemble.command, "production");
assert.equal(servers["ensemble-test"], undefined);
assert.equal(nodeWebUrl("https://app.ensemblework.com", "https://node.ensemblework.com"), "https://test.ensemblework.com");
assert.ok(compareVersions("0.4.9-testing.2", "0.4.9-testing.1") > 0);
assert.notEqual(detectInstallMethod({ bundlePath: "/opt/homebrew/Cellar/ensemble/0.4.9/libexec/lib/ensemble.mjs", platform: "darwin" }), "homebrew");
const notice = await dailyUpdateNotice({ paths, env: {}, currentVersion: "0.4.9-testing.1", fetchImpl: async (url) => {
  assert.equal(url, "https://github.com/ensemblework/ensemble/releases/download/cli-testing-latest/channel.json");
  return Response.json({ channel: "testing", apiBase: "https://api-test.ensemblework.com", version: "0.4.9-testing.2" });
}});
assert.match(notice, /0.4.9-testing.2/);
console.log("testing isolation passed");
`,
      },
      outfile, bundle: true, platform: "node", format: "esm", mainFields: ["module", "main"], logLevel: "silent",
      banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
      define: { __ENSEMBLE_CLI_CHANNEL__: '"testing"' },
    });
    assert.match(execFileSync(process.execPath, [outfile, temp], { encoding: "utf8" }), /testing isolation passed/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
