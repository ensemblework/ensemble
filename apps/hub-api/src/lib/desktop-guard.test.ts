import assert from "node:assert/strict";
import test from "node:test";
import { DESKTOP_WEBVIEW_ORIGINS, desktopHostAllowed } from "./desktop-guard.js";

test("the desktop API only answers loopback hosts", () => {
  assert.equal(desktopHostAllowed("127.0.0.1:54321"), true);
  assert.equal(desktopHostAllowed("localhost:4000"), true);
  assert.equal(desktopHostAllowed("[::1]:4000"), true);
  assert.equal(desktopHostAllowed("evil.example"), false);
  assert.equal(desktopHostAllowed(undefined), false);
});

test("the desktop webview origins are exactly the six the Tauri window can use", () => {
  // Adding or dropping an origin here widens or breaks CORS and the terminal refusal, so it must be a deliberate change.
  assert.deepEqual(
    [...DESKTOP_WEBVIEW_ORIGINS].sort(),
    [
      "ensemble://localhost",
      "http://ensemble.localhost",
      "http://tauri.localhost",
      "https://ensemble.localhost",
      "https://tauri.localhost",
      "tauri://localhost",
    ],
  );
});
