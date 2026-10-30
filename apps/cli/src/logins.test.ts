import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { formatLogins, parseBrowserArgs, readLoginInput } from "./logins.js";

test("ensemble browser: logins, save-login with an optional seed, forget-login; anything else shows the usage", () => {
  assert.deepEqual(parseBrowserArgs([]), { subcommand: "logins" });
  assert.deepEqual(parseBrowserArgs(["logins", "list"]), { subcommand: "logins" });
  assert.deepEqual(parseBrowserArgs(["save-login", "https://app.example.com"]), { subcommand: "save-login", origin: "https://app.example.com", totp: false });
  assert.deepEqual(parseBrowserArgs(["save-login", "--totp", "app.example.com"]), { subcommand: "save-login", origin: "app.example.com", totp: true });
  assert.deepEqual(parseBrowserArgs(["forget-login", "app.example.com"]), { subcommand: "forget-login", origin: "app.example.com" });
  assert.match((parseBrowserArgs(["save-login"], "ensemble-test") as { error: string }).error, /^Usage: ensemble-test browser save-login <site>/);
  assert.match((parseBrowserArgs(["save-login", "a", "b"]) as { error: string }).error, /save-login <site>/);
  assert.match((parseBrowserArgs(["forget-login"]) as { error: string }).error, /forget-login <site>/);
  assert.match((parseBrowserArgs(["passwords"]) as { error: string }).error, /logins \[list\] \| save-login/);
});

test("saved logins are listed by site and user name, never a password", () => {
  assert.match(formatLogins([], "ensemble-test"), /No logins saved .*`ensemble-test browser save-login <site>`/);
  const text = formatLogins([
    { origin: "https://app.example.com", username: "mira@example.com", totp: true, createdAt: "2026-11-17T10:00:00.000Z", usedAt: "2026-11-18T09:00:00.000Z" },
    { origin: "http://localhost:3000", username: "admin", totp: false, createdAt: "2026-11-16T10:00:00.000Z", usedAt: null },
  ]);
  assert.match(text, /https:\/\/app\.example\.com {2}mira@example\.com {2}\+ one-time codes {2}saved 2026-11-17, used 2026-11-18/);
  assert.match(text, /^http:\/\/localhost:3000 {4}admin {2}saved 2026-11-16$/m);
});

test("a login piped in: the user name, the password and the seed, one per line", async () => {
  const piped = (text: string) => Object.assign(Readable.from([Buffer.from(text)]), { isTTY: false }) as unknown as NodeJS.ReadStream;
  assert.deepEqual(await readLoginInput("https://app.example.com", false, piped(" mira@example.com \nh0rse battery \n")), { username: "mira@example.com", password: "h0rse battery " });
  assert.deepEqual(await readLoginInput("https://app.example.com", true, piped("mira\npw\nJBSWY3DPEHPK3PXP\n")), { username: "mira", password: "pw", totp: "JBSWY3DPEHPK3PXP" });
  assert.deepEqual(await readLoginInput("https://app.example.com", false, piped("mira\npw\nJBSWY3DPEHPK3PXP\n")), { username: "mira", password: "pw" }, "a seed only with --totp");
});
