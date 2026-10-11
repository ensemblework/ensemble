import test from "node:test";
import assert from "node:assert/strict";
import { resolveCliPaths, resolveConfigDir, resolveDataHome, resolveLegacyDataHome } from "./paths.js";

test("resolves config and data paths per platform", () => {
  assert.equal(
    resolveConfigDir({ platform: "win32", home: "C:\\Users\\Mira", env: { APPDATA: "C:\\Users\\Mira\\AppData\\Roaming" } }),
    "C:\\Users\\Mira\\AppData\\Roaming\\Ensemble",
  );
  assert.equal(resolveConfigDir({ platform: "linux", home: "/home/mira", env: { XDG_CONFIG_HOME: "/tmp/config" } }), "/tmp/config/ensemble");
});

test("the data folder is the desktop app's, so the CLI and the app share one runtime", () => {
  assert.equal(
    resolveDataHome({ platform: "win32", home: "C:\\Users\\Mira", env: { APPDATA: "C:\\Users\\Mira\\AppData\\Roaming" } }),
    "C:\\Users\\Mira\\AppData\\Roaming\\com.ensemblework.desktop",
  );
  assert.equal(resolveDataHome({ platform: "linux", home: "/home/mira", env: { XDG_DATA_HOME: "/tmp/data" } }), "/tmp/data/com.ensemblework.desktop");
  assert.equal(resolveDataHome({ platform: "linux", home: "/home/mira", env: {} }), "/home/mira/.local/share/com.ensemblework.desktop");
  assert.equal(resolveDataHome({ platform: "darwin", home: "/Users/mira", env: {} }), "/Users/mira/Library/Application Support/com.ensemblework.desktop");
  assert.equal(
    resolveLegacyDataHome({ platform: "win32", home: "C:\\Users\\Mira", env: { LOCALAPPDATA: "C:\\Users\\Mira\\AppData\\Local" } }),
    "C:\\Users\\Mira\\AppData\\Local\\Ensemble",
  );
  assert.equal(resolveLegacyDataHome({ platform: "darwin", home: "/Users/mira", env: {} }), "/Users/mira/Library/Application Support/Ensemble CLI");
  assert.equal(resolveLegacyDataHome({ platform: "linux", home: "/home/mira", env: { XDG_DATA_HOME: "/tmp/data" } }), "/tmp/data/ensemble");
});

test("ENSEMBLE_CONFIG_DIR and ENSEMBLE_DATA_HOME override defaults", () => {
  const paths = resolveCliPaths({
    platform: "linux",
    home: "/home/mira",
    env: { ENSEMBLE_CONFIG_DIR: "/tmp/ensemble-config", ENSEMBLE_DATA_HOME: "/tmp/ensemble-data" },
  });
  assert.equal(paths.configFile, "/tmp/ensemble-config/config.json");
  assert.equal(paths.credentialsFile, "/tmp/ensemble-config/credentials.json");
  assert.equal(paths.discoveryFile, "/tmp/ensemble-data/api.json");
  assert.equal(paths.runnerLog, "/tmp/ensemble-data/logs/runner.log");
});
