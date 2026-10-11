/**
 * The Linux and Windows backends, checked on every OS by the arguments they
 * build. The live escape tests that need the real sandbox are in
 * `os-escape.test.ts` and run on Linux and Windows in CI.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { bubblewrapArgs, kernelHasLandlockNetwork, landrunArgs } from "./linux.js";
import type { SandboxPolicy } from "./policy.js";
import { cmdLine, quoteWindowsArg, windowsToolchainReads } from "./windows.js";

const home = "/home/mira";
function policy(over: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    runId: "job",
    cwd: `${home}/ensemble-workspace/runs/job`,
    readWrite: [`${home}/ensemble-workspace/runs/job`, `${home}/ensemble-workspace/.cache`],
    readOnly: [],
    deny: [],
    network: "none",
    env: { PATH: "/usr/bin" },
    who: "agent",
    home,
    ensembleSource: "/opt/ensemble-cli/sidecar/app",
    appDataDir: `${home}/.local/share/com.ensemblework.desktop`,
    confined: true,
    ...over,
  };
}
const present = (paths: string[]) => (path: string) => paths.includes(path);

test("bubblewrap hides the home folder, mounts back the grants, and cuts the network", () => {
  const args = bubblewrapArgs(policy(), { program: "/usr/bin/git", args: ["status"] }, {
    exists: present(["/run/user", "/var/run/docker.sock", `${home}/.nvm`, "/opt/ensemble-cli/sidecar/app"]),
    execPath: "/usr/bin/node",
    // /var/run is a link to /run on most systems; bubblewrap must be given the real path.
    real: (path) => path.replace(/^\/var\/run\//, "/run/"),
  });
  const text = args.join(" ");
  assert.ok(text.includes("--unshare-net"));
  assert.ok(text.includes("--ro-bind / /"));
  assert.ok(text.indexOf(`--tmpfs ${home}`) < text.indexOf(`--bind-try ${home}/ensemble-workspace/runs/job`), "the home folder is emptied before the grant is mounted");
  assert.ok(text.includes("--tmpfs /run/user"), "agent sockets are hidden");
  assert.ok(text.includes("--ro-bind /dev/null /run/docker.sock"), "the Docker socket is hidden, at its real path");
  assert.ok(text.includes(`--ro-bind ${home}/.nvm ${home}/.nvm`), "toolchains are readable");
  assert.ok(text.includes("--tmpfs /opt/ensemble-cli/sidecar/app"), "Ensemble's own code is hidden even outside home");
  assert.deepEqual(args.slice(-5), ["--chdir", `${home}/ensemble-workspace/runs/job`, "--", "/usr/bin/git", "status"]);
});

test("bubblewrap keeps the network when the run allows it", () => {
  const args = bubblewrapArgs(policy({ network: "outbound" }), { program: "/usr/bin/curl", args: ["https://example.com"] }, { exists: () => false, execPath: "/usr/bin/node", real: (path) => path });
  assert.ok(!args.includes("--unshare-net"));
});

test("landrun grants only the work folder, the cache, the system and toolchains", () => {
  const args = landrunArgs(policy(), { program: "/usr/bin/git", args: ["status"] }, { PATH: "/usr/bin", HOME: `${home}/x` }, { exists: present(["/usr", "/bin", "/etc", `${home}/.cargo`]), execPath: "/usr/bin/node" });
  const pairs = (flag: string) => args.flatMap((value, index) => (value === flag ? [args[index + 1]] : []));
  assert.deepEqual(pairs("--rwx"), ["/tmp", `${home}/ensemble-workspace/runs/job`, `${home}/ensemble-workspace/.cache`]);
  assert.ok(pairs("--rox").includes(`${home}/.cargo`));
  assert.ok(!pairs("--rox").includes(home) && !pairs("--ro").includes(home), "never the home folder itself");
  assert.ok(!args.includes("--unrestricted-network"));
  assert.deepEqual(pairs("--env"), ["PATH", "HOME"]);
  assert.deepEqual(args.slice(-3), ["--", "/usr/bin/git", "status"]);
});

test("landrun refuses a grant that would expose the home folder or Ensemble's data", () => {
  assert.throws(() => landrunArgs(policy({ readWrite: [home] }), { program: "/usr/bin/ls", args: [] }, {}, { exists: () => false }), /home folder/);
  assert.throws(
    () => landrunArgs(policy({ readOnly: [`${home}/.local/share`] }), { program: "/usr/bin/ls", args: [] }, {}, { exists: () => false }),
    /com\.ensemblework\.desktop/,
  );
  assert.throws(() => landrunArgs(policy({ readWrite: ["/srv/a,b"] }), { program: "/usr/bin/ls", args: [] }, {}, { exists: () => false }), /commas/);
});

test("Landlock turns the network off from Linux 6.7", () => {
  assert.equal(kernelHasLandlockNetwork("6.8.0-45-generic"), true);
  assert.equal(kernelHasLandlockNetwork("6.7.1"), true);
  assert.equal(kernelHasLandlockNetwork("6.6.30-microsoft-standard-WSL2"), false);
  assert.equal(kernelHasLandlockNetwork("5.15.0-122-generic"), false);
  assert.equal(kernelHasLandlockNetwork("7.0.2"), true);
});

test("Windows arguments are quoted the way CreateProcess reads them", () => {
  assert.equal(quoteWindowsArg("plain"), "plain");
  assert.equal(quoteWindowsArg("two words"), '"two words"');
  assert.equal(quoteWindowsArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteWindowsArg("C:\\path with space\\"), '"C:\\path with space\\\\"');
  assert.equal(quoteWindowsArg(""), '""');
});

test("a .cmd program goes through cmd.exe with metacharacters escaped", () => {
  const line = cmdLine("C:\\Program Files\\nodejs\\npm.cmd", ["run", "test", "100%"]);
  assert.ok(line.startsWith("C:\\Program^ Files\\nodejs\\npm.cmd"));
  assert.ok(line.includes('^"100^%^"'), line);
});

test("toolchains on PATH under the profile are readable; secrets and the profile itself are not", () => {
  const winHome = "C:\\Users\\Mira";
  const path = [
    "C:\\Windows\\System32",
    `${winHome}\\AppData\\Roaming\\nvm`,
    `${winHome}\\.ssh`,
    `${winHome}\\AppData\\Local\\Programs\\Python\\Python312`,
    winHome,
    `${winHome}\\AppData\\Roaming\\com.ensemblework.desktop\\bin`,
  ].join(";");
  const reads = windowsToolchainReads(path, winHome, [`${winHome}\\AppData\\Roaming\\com.ensemblework.desktop`], () => true);
  assert.deepEqual(reads, [`${winHome}\\AppData\\Roaming\\nvm`, `${winHome}\\AppData\\Local\\Programs\\Python\\Python312`]);
});
