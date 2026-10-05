import assert from "node:assert/strict";
import test from "node:test";
import { desktopDiscoveryPath as discoveryFromScript, parseDesktopDiscovery as parseFromScript, resolveHookTarget as hookFromScript } from "../../../scripts/desktop-discovery.mjs";
import { desktopDiscoveryPath, parseDesktopDiscovery, resolveHookTarget } from "./desktop-discovery.js";

test("discovery path follows the OS app-data folder", () => {
  assert.equal(
    desktopDiscoveryPath({ platform: "linux", home: "/home/ada" }),
    "/home/ada/.local/share/com.ensemblework.desktop/api.json",
  );
  assert.equal(
    desktopDiscoveryPath({ platform: "linux", home: "/home/ada", env: { XDG_DATA_HOME: "/data" } }),
    "/data/com.ensemblework.desktop/api.json",
  );
  assert.equal(
    desktopDiscoveryPath({ platform: "darwin", home: "/Users/ada" }),
    "/Users/ada/Library/Application Support/com.ensemblework.desktop/api.json",
  );
  assert.equal(
    desktopDiscoveryPath({ platform: "win32", home: "C:\\Users\\ada", env: { APPDATA: "C:\\Users\\ada\\AppData\\Roaming" } }),
    "C:\\Users\\ada\\AppData\\Roaming\\com.ensemblework.desktop\\api.json",
  );
  assert.equal(
    desktopDiscoveryPath({ platform: "linux", home: "/home/ada", env: { ENSEMBLE_DISCOVERY_FILE: "/tmp/api.json" } }),
    "/tmp/api.json",
  );
});

test("the editor hook uses the same path and parser", () => {
  const cases = [
    { platform: "linux", home: "/home/ada" },
    { platform: "darwin", home: "/Users/ada" },
    { platform: "win32", home: "C:\\Users\\ada", env: { APPDATA: "C:\\Users\\ada\\AppData\\Roaming" } },
    { platform: "linux", home: "/home/ada", env: { ENSEMBLE_DISCOVERY_FILE: "/tmp/custom.json" } },
  ];
  for (const input of cases) {
    assert.equal(discoveryFromScript(input), desktopDiscoveryPath(input));
  }
  const raw = '{"port":51234,"token":"abcdefghijklmnop"}';
  assert.deepEqual(parseFromScript(raw), parseDesktopDiscovery(raw));
});

test("the hook follows discovery only for the dev default", () => {
  const discovery = { port: 51234, token: "abcdefghijklmnop" };
  const found = resolveHookTarget({ discovery });
  assert.deepEqual(found, hookFromScript({ discovery }));
  assert.equal(found.base, "http://127.0.0.1:51234");
  assert.equal(found.token, discovery.token);
  const kept = resolveHookTarget({
    configUrl: "http://127.0.0.1:4000",
    configToken: "ens_personal",
    discovery,
  });
  assert.equal(kept.base, "http://127.0.0.1:51234");
  assert.equal(kept.token, "ens_personal");
  const remote = resolveHookTarget({ configUrl: "https://hub.example.com", configToken: "ens_personal", discovery });
  assert.equal(remote.base, "https://hub.example.com");
  assert.equal(remote.token, "ens_personal");
  assert.equal(resolveHookTarget({ discovery: null }).base, "http://127.0.0.1:4000");
});

test("discovery JSON requires a port and a token", () => {
  assert.deepEqual(parseDesktopDiscovery('{"port":4000,"token":"abcdefghijklmnop"}'), {
    port: 4000,
    token: "abcdefghijklmnop",
  });
  assert.equal(parseDesktopDiscovery('{"port":0,"token":"abcdefghijklmnop"}'), null);
  assert.equal(parseDesktopDiscovery('{"port":4000,"token":"short"}'), null);
  assert.equal(parseDesktopDiscovery("not json"), null);
});
