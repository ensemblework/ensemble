/**
 * Live escapes against this computer's real sandbox: bubblewrap or Landlock
 * on Linux, the sandbox account on Windows, Seatbelt on macOS. Each case
 * starts a real child under `startSandboxed` and checks the OS refused it.
 * When this computer has no sandbox the cases are skipped with the reason;
 * CI runs them on Linux (both backends) and Windows.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { desktopDataDir } from "@ensemble/shared-types/desktop-discovery";
import type { SandboxPolicy } from "./policy.js";
import { capabilities, prepareNetwork, prepareSandbox, setupSandbox, startSandboxed } from "./spawn.js";

const home = homedir();

function run(policy: SandboxPolicy, script: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const { child } = startSandboxed(policy, { program: process.execPath, args: ["-e", script] });
    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

function base(root: string, over: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    runId: "escape",
    cwd: root,
    readWrite: [root],
    readOnly: [],
    deny: [],
    network: "none",
    env: { PATH: process.env.PATH ?? process.env.Path ?? "", SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root, TMPDIR: root },
    who: "agent",
    home,
    ensembleSource: join(home, "ensemble-escape-source"),
    appDataDir: desktopDataDir({ platform: process.platform, home }),
    confined: true,
    ...over,
  };
}

/** CI turns the sandbox on (Windows setup) and requires it; elsewhere a computer without one skips. */
async function sandboxHere(): Promise<ReturnType<typeof capabilities>> {
  let caps = await prepareSandbox();
  if (!caps.osSandbox && caps.setup?.needed && process.env.ENSEMBLE_SANDBOX_SETUP_IN_TEST === "1") caps = (await setupSandbox()).caps;
  if (!caps.osSandbox && process.env.ENSEMBLE_REQUIRE_OS_SANDBOX === "1") assert.fail(`This CI runner must have an OS sandbox: ${caps.reason}`);
  return caps;
}

test("the OS sandbox keeps a command inside its folder", { timeout: 300_000 }, async (t) => {
  const caps = await sandboxHere();
  if (!caps.osSandbox) {
    t.skip(`no OS sandbox here: ${caps.reason}`);
    return;
  }
  // The work folder lives under the home folder, like ~/ensemble-workspace does.
  const parent = mkdtempSync(join(home, "ensemble-escape-"));
  const root = join(parent, "work");
  const outside = join(parent, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  const secret = join(parent, "secret.txt");
  writeFileSync(secret, "do-not-read");
  const sneaky = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ensemble-escape-elsewhere-"));
  try {
    await t.test("writes inside the folder work", async () => {
      const result = await run(base(root), `require("fs").writeFileSync(${JSON.stringify(join(root, "ok.txt"))}, "ok")`);
      assert.equal(result.code, 0, result.output);
      assert.equal(readFileSync(join(root, "ok.txt"), "utf8"), "ok");
    });

    await t.test("a write next to the folder is refused", async () => {
      const target = join(outside, "escaped.txt");
      const result = await run(base(root), `require("fs").writeFileSync(${JSON.stringify(target)}, "x")`);
      assert.notEqual(result.code, 0, result.output);
      assert.equal(existsSync(target), false);
    });

    await t.test("a file elsewhere in the home folder cannot be read", async () => {
      const result = await run(base(root), `process.stdout.write(require("fs").readFileSync(${JSON.stringify(secret)}, "utf8"))`);
      assert.notEqual(result.code, 0);
      assert.doesNotMatch(result.output, /do-not-read/);
    });

    await t.test("a write to another temp folder is refused", async (sub) => {
      if (caps.mechanism === "landlock" || caps.mechanism === "seatbelt") {
        sub.skip("Landlock and Seatbelt allow the shared /tmp, like the system's own temp folder");
        return;
      }
      const target = join(sneaky, "escaped.txt");
      await run(base(root), `require("fs").writeFileSync(${JSON.stringify(target)}, "x")`);
      assert.equal(existsSync(target), false);
    });

    await t.test("with the internet off, a TCP connection fails", async (sub) => {
      if (caps.networkOff === false) {
        sub.skip("this kernel cannot turn the network off inside Landlock");
        return;
      }
      const server = createServer((socket) => socket.end("hello")).listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      const port = (server.address() as { port: number }).port;
      try {
        const script = `const s=require("net").connect(${port},"127.0.0.1");s.on("data",d=>{process.stdout.write(String(d));process.exit(0)});s.on("error",e=>{console.error(e.code);process.exit(3)});setTimeout(()=>process.exit(4),5000)`;
        const result = await run(base(root), script);
        assert.notEqual(result.code, 0, result.output);
        assert.doesNotMatch(result.output, /hello/);
      } finally {
        server.close();
      }
    });

    await t.test("Ensemble's own data folder is never readable", async (sub) => {
      const appData = desktopDataDir({ platform: process.platform, home });
      if (!existsSync(appData)) {
        sub.skip("no Ensemble data folder on this computer");
        return;
      }
      const result = await run(base(root), `require("fs").readdirSync(${JSON.stringify(appData)})`);
      assert.notEqual(result.code, 0, result.output);
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(sneaky, { recursive: true, force: true });
  }
});

test("a run with the internet on can reach the network stack", { timeout: 60_000 }, async (t) => {
  const caps = await sandboxHere();
  if (!caps.osSandbox || process.platform === "win32") {
    t.skip(process.platform === "win32" ? "Windows sends traffic through the sandbox proxy; covered by the proxy test" : `no OS sandbox here: ${caps.reason}`);
    return;
  }
  await prepareNetwork();
  const parent = mkdtempSync(join(home, "ensemble-escape-net-"));
  try {
    const server = createServer((socket) => socket.end("hello")).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const script = `const s=require("net").connect(${port},"127.0.0.1");s.on("data",d=>{process.stdout.write(String(d));process.exit(0)});s.on("error",e=>{console.error(e.code);process.exit(3)})`;
      const result = await run(base(parent, { network: "outbound" }), script);
      if (caps.mechanism === "seatbelt") {
        // The macOS profile keeps localhost closed even with the internet on.
        assert.notEqual(result.code, 0);
      } else {
        assert.equal(result.code, 0, result.output);
        assert.match(result.output, /hello/);
      }
    } finally {
      server.close();
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
