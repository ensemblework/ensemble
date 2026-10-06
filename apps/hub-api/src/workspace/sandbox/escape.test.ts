/**
 * Seatbelt escapes, and the rule that a child never sees a git token.
 *
 * Profile text is checked on every OS. A live child is started on every OS
 * to prove `ENSEMBLE_GIT_TOKEN` is gone from the environment. The filesystem,
 * LaunchServices, Unix-socket, and Never-binary cases run only on macOS,
 * where Seatbelt is actually applied. Linux is not safe yet.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { desktopDataDir } from "@ensemble/shared-types/desktop-discovery";
import type { SandboxPolicy } from "./policy.js";
import { prepareSpawn, startSandboxed } from "./spawn.js";
import { compileSeatbeltProfile, nodeToolchainRead } from "./seatbelt.js";
import { scrubAgentEnv } from "./scrub.js";

const TOKEN = "ghp_ensemble_escape_token_value";
const darwin = process.platform === "darwin";

function profile(): string {
  const home = "/Users/person";
  return compileSeatbeltProfile({
    home,
    readWrite: ["/Users/person/ensemble-workspace/runs/job"],
    readOnly: [],
    deny: [desktopDataDir({ platform: "darwin", home })],
    network: "none",
    who: "agent",
    ensembleSource: "/Users/person/src/ensemble",
    askpassPath: "/Users/person/ensemble-workspace/.cache/git-askpass.sh",
  });
}

test("the profile denies open, sockets, home, app data, secrets, and never-binaries", () => {
  const text = profile();
  const home = "/Users/person";
  assert.match(text, /\(deny process-exec/);
  for (const bin of ["/usr/bin/open", "/usr/bin/osascript", "/usr/bin/ssh", "/usr/bin/security"]) {
    assert.match(text, new RegExp(`\\(literal "${bin}"\\)`));
  }
  assert.match(text, /\(deny network-outbound \(remote unix-socket\)\)/);
  assert.match(text, /\(deny network\*\)/);
  assert.match(text, new RegExp(`\\(deny file-read\\* \\(subpath "${home}"\\)\\)`));
  assert.match(text, /Library\/Application Support\/com\.ensemblework\.desktop/);
  assert.match(text, /\.git-credentials/);
  assert.match(text, /git-askpass\.sh/);
  assert.match(text, /com\.apple\.coreservices\.launchservicesd/);
  const homeAt = text.indexOf(`(deny file-read* (subpath "${home}"))`);
  const grantAt = text.indexOf("(allow file-read*");
  assert.ok(homeAt > 0 && grantAt > homeAt, "the workspace allow comes after the home deny");
  assert.doesNotMatch(text, /ENSEMBLE_GIT_TOKEN|ghp_/);
});

test("node under the home directory is readable without opening the rest of home", () => {
  const home = "/Users/runner";
  assert.equal(nodeToolchainRead(home, "/usr/local/bin/node"), null);
  assert.equal(nodeToolchainRead(home, `${home}/hostedtoolcache/node/22.14.0/bin/node`), `${home}/hostedtoolcache`);
  assert.equal(nodeToolchainRead(home, `${home}/.nvm/versions/node/v22.14.0/bin/node`), `${home}/.nvm/versions/node/v22.14.0/bin`);
  assert.equal(nodeToolchainRead(home, `${home}/Documents/node/bin/node`), null);
  assert.equal(
    nodeToolchainRead(home, `${home}/Library/Application Support/com.ensemblework.desktop/node`),
    `${home}/Library/Application Support/com.ensemblework.desktop`,
  );
});

test("named grants allow ancestor metadata without opening ancestor contents", () => {
  const text = profile();
  assert.match(text, /\(allow file-read-metadata.*\(literal "\/Users\/person"\)/);
  assert.match(text, /\(literal "\/Users\/person\/ensemble-workspace"\)/);
  assert.doesNotMatch(text, /\(allow file-read\* \(subpath "\/Users\/person"\)/);
  assert.ok(text.indexOf("(allow file-read-metadata") < text.indexOf(';; More specific'));
});

test("scrub drops git tokens and askpass from an agent environment", () => {
  const env = scrubAgentEnv(
    {
      PATH: "/usr/bin",
      HOME: "/tmp/fake-home",
      ENSEMBLE_GIT_TOKEN: TOKEN,
      GITHUB_TOKEN: TOKEN,
      GH_TOKEN: TOKEN,
      GIT_ASKPASS: "/tmp/git-askpass.sh",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      MY_APP_PASSWORD: "secret",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      LANG: "C",
    },
    "agent",
  );
  assert.equal(env.ENSEMBLE_GIT_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.MY_APP_PASSWORD, undefined);
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.equal(env.GIT_ASKPASS, "/usr/bin/false");
  assert.equal(env.SSH_ASKPASS, "/usr/bin/false");
  assert.equal(env.HOME, "/tmp/fake-home");
  assert.equal(env.LANG, "C");
  assert.equal(env.PATH, "/usr/bin");
});

function policy(extra: Partial<SandboxPolicy> = {}): SandboxPolicy {
  const home = homedir();
  const grant = join(tmpdir(), "ensemble-escape-grant");
  return {
    runId: "escape",
    cwd: grant,
    readWrite: [grant],
    readOnly: [],
    deny: [],
    network: "none",
    env: { PATH: process.env.PATH, HOME: home, ENSEMBLE_GIT_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN, GIT_ASKPASS: "/tmp/askpass.sh" },
    who: "agent",
    home,
    ensembleSource: join(tmpdir(), "ensemble-source-deny"),
    appDataDir: desktopDataDir({ platform: process.platform, home }),
    askpassPath: join(tmpdir(), "git-askpass.sh"),
    confined: true,
    ...extra,
  };
}

test("prepareSpawn never puts a git token in the child, on either platform", () => {
  for (const platform of ["linux", "darwin"] as const) {
    const prepared = prepareSpawn(policy(platform === "linux" ? { advisoryOk: true } : {}), { program: "/bin/true", args: [] }, platform);
    assert.equal(prepared.env.ENSEMBLE_GIT_TOKEN, undefined);
    assert.equal(prepared.env.GITHUB_TOKEN, undefined);
    assert.equal(prepared.env.GIT_ASKPASS, "/usr/bin/false");
    assert.doesNotMatch(prepared.args.join("\n"), new RegExp(TOKEN));
    if (platform === "darwin") {
      assert.equal(prepared.command, "/usr/bin/sandbox-exec");
      assert.equal(prepared.sandboxed, true);
    } else {
      assert.equal(prepared.sandboxed, false);
    }
  }
});

test("a confined spawn on Linux is refused and says it is not safe", () => {
  assert.throws(() => prepareSpawn(policy(), { program: "/bin/true", args: [] }, "linux"), /not safe/);
});

function pythonBin(): string | null {
  const found = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
  if (found.status !== 0) return null;
  const path = found.stdout.trim();
  return path || null;
}

function runChild(input: SandboxPolicy, program: string, args: string[], timeoutMs = 20_000): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const { child } = startSandboxed(input, { program, args });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}

test("a live child cannot read a git token from the environment", async () => {
  const python = pythonBin();
  assert.ok(python, "python3 is required");
  const grant = join(tmpdir(), `ensemble-token-env-${process.pid}`);
  mkdirSync(grant, { recursive: true });
  const script = join(grant, "env.py");
  writeFileSync(script, "import os\nprint('TOKEN=' + os.environ.get('ENSEMBLE_GIT_TOKEN', ''))\nprint('GITHUB=' + os.environ.get('GITHUB_TOKEN', ''))\nprint('ASK=' + os.environ.get('GIT_ASKPASS', ''))\n");
  try {
    const result = await runChild(
      policy({ cwd: grant, readWrite: [grant], advisoryOk: !darwin }),
      python!,
      [script],
    );
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /TOKEN=\n/);
    assert.match(result.output, /GITHUB=\n/);
    assert.doesNotMatch(result.output, new RegExp(TOKEN));
    assert.match(result.output, /ASK=\/usr\/bin\/false/);
  } finally {
    rmSync(grant, { recursive: true, force: true });
  }
});

test("seatbelt blocks open, sockets, home, app data, never-binaries, and token files", { skip: !darwin }, async () => {
  const python = pythonBin();
  assert.ok(python, "python3 is required");
  const home = homedir();
  const grant = join(tmpdir(), `ensemble-seatbelt-${process.pid}`);
  const appData = desktopDataDir({ platform: "darwin", home });
  const askpass = join(tmpdir(), `ensemble-askpass-${process.pid}.sh`);
  const cred = join(home, ".git-credentials");
  const credBackup = existsSync(cred) ? readFileSync(cred) : null;
  const doc = join(home, "Documents", `ensemble-seatbelt-secret-${process.pid}.txt`);
  const nvm = join(home, ".nvm", `ensemble-toolchain-${process.pid}.txt`);
  const marker = join(home, "Documents", `ensemble-open-escape-${process.pid}`);
  const sockPath = join(tmpdir(), `ensemble-sock-${process.pid}.sock`);
  mkdirSync(grant, { recursive: true });
  mkdirSync(appData, { recursive: true });
  mkdirSync(join(home, "Documents"), { recursive: true });
  mkdirSync(join(home, ".nvm"), { recursive: true });
  writeFileSync(join(appData, "secret.txt"), TOKEN);
  writeFileSync(cred, `https://x:${TOKEN}@github.com\n`);
  writeFileSync(askpass, `#!/bin/sh\nprintf '%s\\n' "${TOKEN}"\n`);
  chmodSync(askpass, 0o700);
  writeFileSync(doc, TOKEN);
  writeFileSync(nvm, "toolchain-ok");
  const commandFile = join(grant, "escape.command");
  writeFileSync(commandFile, `#!/bin/bash\ntouch ${JSON.stringify(marker)}\n`);
  chmodSync(commandFile, 0o755);
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => resolve());
  });
  const input = policy({
    cwd: grant,
    readWrite: [grant],
    askpassPath: askpass,
    appDataDir: appData,
    advisoryOk: false,
  });
  const py = async (body: string) => {
    const file = join(grant, `case-${Math.random().toString(16).slice(2)}.py`);
    writeFileSync(file, body);
    return runChild(input, python!, [file]);
  };
  try {
    const ok = await runChild(input, "/usr/bin/true", []);
    assert.equal(ok.code, 0, ok.output);

    const wrote = await py("open('inside.txt','w').write('workspace-ok')\nprint(open('inside.txt').read())\n");
    assert.equal(wrote.code, 0, wrote.output);
    assert.match(wrote.output, /workspace-ok/);

    const opened = await py(
      `import subprocess, sys\n` +
        `r = subprocess.run([${JSON.stringify("/usr/bin/open")}, ${JSON.stringify(commandFile)}])\n` +
        `print("OPEN", r.returncode)\n` +
        `sys.exit(0 if r.returncode == 0 else 1)\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.notEqual(opened.code, 0, opened.output);
    assert.equal(existsSync(marker), false, "LaunchServices must not create the marker outside the sandbox");

    const socket = await py(
      `import socket, sys\n` +
        `s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\n` +
        `s.settimeout(2)\n` +
        `s.connect(${JSON.stringify(sockPath)})\n` +
        `print("CONNECTED")\n`,
    );
    assert.doesNotMatch(socket.output, /CONNECTED/);
    assert.notEqual(socket.code, 0, socket.output);

    const files = await py(
      `from pathlib import Path\n` +
        `paths = ${JSON.stringify([join(appData, "secret.txt"), cred, askpass, doc, join(appData, "write-escape.txt")])}\n` +
        `for path in paths:\n` +
        `    try:\n` +
        `        if path.endswith("write-escape.txt"):\n` +
        `            Path(path).write_text("wrote")\n` +
        `            print("WROTE", path)\n` +
        `        else:\n` +
        `            print("READ", path, Path(path).read_text()[:40])\n` +
        `    except Exception as error:\n` +
        `        print("DENY", type(error).__name__)\n` +
        `print("TOOLCHAIN", Path(${JSON.stringify(nvm)}).read_text())\n`,
    );
    assert.doesNotMatch(files.output, new RegExp(TOKEN));
    assert.match(files.output, /TOOLCHAIN toolchain-ok/);
    assert.doesNotMatch(files.output, /WROTE/);
    assert.equal(existsSync(join(appData, "write-escape.txt")), false);

    const osascript = await py(
      `import os, sys\ntry:\n    os.execv("/usr/bin/osascript", ["osascript", "-e", "return 1"])\nexcept OSError as error:\n    print("DENIED", error)\n    sys.exit(1)\n`,
    );
    assert.notEqual(osascript.code, 0, osascript.output);
    assert.match(osascript.output, /DENIED/);

    const ssh = await runChild(input, process.execPath, [
      "-e",
      `const { execFileSync } = require("child_process"); try { execFileSync("/usr/bin/ssh", ["-G", "example.invalid"]); console.log("SSH_OK"); } catch (error) { console.log("SSH_DENIED"); process.exit(1); }`,
    ]);
    assert.doesNotMatch(ssh.output, /SSH_OK/);
    assert.notEqual(ssh.code, 0, ssh.output);

    const shell = await runChild(input, "/bin/sh", ["-c", "/usr/bin/osascript -e 'return 1'"]);
    assert.notEqual(shell.code, 0, shell.output);
  } finally {
    server.close();
    rmSync(sockPath, { force: true });
    rmSync(grant, { recursive: true, force: true });
    rmSync(askpass, { force: true });
    rmSync(doc, { force: true });
    rmSync(nvm, { force: true });
    rmSync(marker, { force: true });
    rmSync(join(appData, "secret.txt"), { force: true });
    if (credBackup) writeFileSync(cred, credBackup);
    else rmSync(cred, { force: true });
  }
});
