import test from "node:test";
import assert from "node:assert/strict";
import { launchAgentPlist, systemdUserUnit, windowsTaskCreateCommand } from "./services.js";
import { detectInstallMethod } from "./update.js";
import { mapStableLauncherPath, resolveLauncherCommand } from "./launcher.js";

test("maps Homebrew and Scoop launcher paths to stable shims", () => {
  assert.equal(mapStableLauncherPath("/opt/homebrew/Cellar/ensemble/0.1.0/libexec/bin/ensemble", "darwin"), "/opt/homebrew/bin/ensemble");
  assert.equal(
    mapStableLauncherPath("C:\\Users\\Mira\\scoop\\apps\\ensemble\\0.1.0\\bin\\ensemble.exe", "win32"),
    "C:\\Users\\Mira\\scoop\\apps\\ensemble\\current\\bin\\ensemble.exe",
  );
});

test("npm installs fall back to npx when no global ensemble is on PATH", () => {
  const command = resolveLauncherCommand({
    argv1: "/tmp/app/node_modules/ensemblework/dist/ensemble.mjs",
    env: { PATH: "" },
    platform: "linux",
    sidecarAvailable: false,
  });
  assert.equal(command.command, "npx");
  assert.deepEqual(command.argsPrefix, ["-y", "ensemblework"]);
});

test("service generators contain the expected runner start command", () => {
  const plist = launchAgentPlist({ launcher: "/usr/local/bin/ensemble", logPath: "/tmp/runner.log" });
  assert.match(plist, /com\.ensemblework\.cli\.runner/);
  assert.match(plist, /<string>runner<\/string>/);
  assert.match(systemdUserUnit({ launcher: "/usr/local/bin/ensemble", logPath: "/tmp/runner.log" }), /Restart=on-failure/);
  assert.deepEqual(windowsTaskCreateCommand("C:\\Program Files\\Ensemble\\ensemble.exe").slice(0, 3), ["/Create", "/TN", "Ensemble Runner"]);
});

test("detects install methods from bundle paths", () => {
  assert.equal(detectInstallMethod({ bundlePath: "/opt/homebrew/Cellar/ensemble/0.1.0/libexec/lib/ensemble.mjs", platform: "darwin" }), "homebrew");
  assert.equal(detectInstallMethod({ bundlePath: "/opt/ensemble-cli/lib/ensemble.mjs", platform: "linux" }), "linux-package");
  assert.equal(
    detectInstallMethod({ bundlePath: "/home/mira/.local/share/ensemble-cli/0.1.0/lib/ensemble.mjs", platform: "linux", home: "/home/mira" }),
    "install-script",
  );
  assert.equal(
    detectInstallMethod({ bundlePath: "/tmp/node_modules/ensemblework/dist/ensemble.mjs", platform: "linux", sidecarAvailable: false }),
    "npm",
  );
  assert.equal(
    detectInstallMethod({ bundlePath: "C:\\Users\\Mira\\scoop\\apps\\ensemble\\current\\lib\\ensemble.mjs", platform: "win32" }),
    "scoop",
  );
  assert.equal(
    detectInstallMethod({
      bundlePath: "C:\\Users\\Mira\\AppData\\Local\\Microsoft\\WinGet\\Packages\\EnsembleWork.EnsembleCLI\\ensemble.mjs",
      platform: "win32",
    }),
    "winget",
  );
});
