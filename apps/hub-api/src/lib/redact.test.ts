import assert from "node:assert/strict";
import test from "node:test";
import { redactArgs, redactRequestUrl, redactText, secretName } from "./redact.js";

test("event tickets and OAuth codes, states and requests are not logged in the url; other values stay", () => {
  assert.equal(redactRequestUrl("/api/events?ticket=abc123"), "/api/events?ticket=[redacted]");
  assert.equal(
    redactRequestUrl("/api/connectors/google/callback?code=secret-code&state=opaque&scope=email"),
    "/api/connectors/google/callback?code=[redacted]&state=[redacted]&scope=email",
  );
  assert.equal(
    redactRequestUrl("/oauth/authorize?client_id=c1&code_challenge=x1&state=s1"),
    "/oauth/authorize?client_id=c1&code_challenge=x1&state=[redacted]",
  );
  assert.equal(redactRequestUrl("/api/auth/oauth/google/start?mcp_request=m1"), "/api/auth/oauth/google/start?mcp_request=[redacted]");
  assert.equal(redactRequestUrl("/oauth?request=req-1"), "/oauth?request=[redacted]");
  assert.equal(redactRequestUrl("/oauth/token?code_verifier=v1"), "/oauth/token?code_verifier=[redacted]");
});

test("bearer tokens, internal tokens, and shaped keys are redacted", () => {
  const line = redactText('failed Authorization: Bearer ens_abc12345 and x-ensemble-internal: dev-internal-token sk-livekeyvalue AIzaSyabcdefghijklmnopqrstuvwxyz12');
  assert.equal(line.includes("ens_abc12345"), false);
  assert.equal(line.includes("dev-internal-token"), false);
  assert.equal(line.includes("sk-livekeyvalue"), false);
  assert.equal(line.includes("AIzaSyabcdefghijklmnopqrstuvwxyz12"), false);
  assert.match(line, /Bearer \[redacted\]/);
  assert.match(line, /x-ensemble-internal: \[redacted\]/);
});

test("cloud keys, private keys, JWTs, URL passwords and .env secret lines are redacted; plain text stays", () => {
  const text = [
    "aws AKIAABCDEFGHIJKLMNOP done",
    "stripe sk_live_abcdefghijklmnop and rk_test_abcdefghijklmnop",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrst",
    "remote https://akash:hunter2secret@github.com/a/b.git",
    "API_KEY=abcd1234efgh",
    "export DB_PASSWORD='p4ssw0rd!'",
    "client_secret: s3cr3tvalue",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
    "TIMEOUT=30 and the README says hello",
  ].join("\n");
  const out = redactText(text);
  for (const secret of ["AKIAABCDEFGHIJKLMNOP", "sk_live_abcdefghijklmnop", "rk_test_abcdefghijklmnop", "eyJhbGciOiJIUzI1NiJ9", "hunter2secret", "abcd1234efgh", "p4ssw0rd!", "s3cr3tvalue", "b3BlbnNzaC1rZXktdjEAAAAA"]) {
    assert.equal(out.includes(secret), false, secret);
  }
  assert.match(out, /https:\/\/akash:\[redacted\]@github\.com/);
  assert.match(out, /API_KEY=\[redacted\]/);
  assert.match(out, /TIMEOUT=30 and the README says hello/);
});


test("saved run secrets are hidden everywhere once known, and names that would change how agents sign in are refused", async () => {
  const { rememberSecretValues, hideSecretsDeep } = await import("./redact.js");
  const { secretNameProblem, secretRules } = await import("./run-secrets.js");
  const value = "zq9-remembered-value-77";
  assert.equal(redactText(`curl -H "X: ${value}"`).includes(value), true, "unknown values are left alone");
  rememberSecretValues([value, "abc"]);
  assert.equal(redactText(`curl -H "X: ${value}"`), 'curl -H "X: [redacted secret]"');
  assert.deepEqual(hideSecretsDeep({ log: [`got ${value}`], n: 2, nested: { summary: value } }), { log: ["got [redacted secret]"], n: 2, nested: { summary: "[redacted secret]" } });
  assert.equal(redactText("abc"), "abc", "very short values are not remembered");

  assert.equal(secretNameProblem("STRIPE_API_KEY"), null);
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "PATH", "ENSEMBLE_TOKEN", "LD_PRELOAD"]) assert.ok(secretNameProblem(name), `${name} is refused`);
  assert.match(secretNameProblem("GITHUB_TOKEN")!, /GITHUB_PAT/);
  assert.ok(secretNameProblem("stripe key"), "an environment variable name");
  assert.deepEqual(secretRules([]), []);
  assert.match(secretRules(["STRIPE_API_KEY"])[0]!, /\$STRIPE_API_KEY.*Never print/);
});

test("redactArgs: secrets by key at any depth and in JSON strings, and inline in any string; names that only look alike stay", () => {
  const sent = {
    keys: { pass: "hunter2", passphrase: "open sesame", auth: { user: "mira", value: "x" }, pin: 4821, apiKey: "k-1", key: "preferred model", author: "Mira" },
    command: "curl -H 'X-Api-Key: abc123def' -H 'Authorization: Bearer abcdefghijklmnop' https://api.example.com/v1?sig=s1gn&X-Amz-Signature=deadbeef&page=2",
    env: "GITHUB_TOKEN=ghx-1234 DB_PASSWORD='p a s s' PORT=8080 node app.js --token t0k3n --name app",
    nested: [{ list: [{ client_secret: "cs" }] }],
    json: JSON.stringify({ password: "pw", inner: { token: "t" }, ok: "stays" }),
    url: "postgres://mira:s3cret@db.example.com/app",
    pinned: true,
  };
  const kept = redactArgs(sent) as Record<string, any>;
  assert.deepEqual(kept.keys, { pass: "[redacted]", passphrase: "[redacted]", auth: "[redacted]", pin: "[redacted]", apiKey: "[redacted]", key: "preferred model", author: "Mira" });
  assert.equal(kept.command, "curl -H 'X-Api-Key: [redacted]' -H 'Authorization: Bearer [redacted]' https://api.example.com/v1?sig=[redacted]&X-Amz-Signature=[redacted]&page=2");
  assert.equal(kept.env, "GITHUB_TOKEN=[redacted] DB_PASSWORD=[redacted] PORT=8080 node app.js --token [redacted] --name app");
  assert.deepEqual(kept.nested, [{ list: [{ client_secret: "[redacted]" }] }]);
  assert.deepEqual(JSON.parse(kept.json), { password: "[redacted]", inner: { token: "[redacted]" }, ok: "stays" });
  assert.equal(kept.url, "postgres://mira:[redacted]@db.example.com/app");
  assert.equal(kept.pinned, true);
  for (const name of ["X-Api-Key", "apiKey", "API_KEY", "DB_PASSWORD", "pin", "sig", "X-Amz-Signature", "passphrase", "authToken"]) assert.ok(secretName(name), name);
  for (const name of ["author", "pinned", "key", "sessionKey", "signal", "design", "passenger"]) assert.ok(!secretName(name), name);
});

test("redactArgs takes time in proportion to the input, even for lines built to make a pattern backtrack", () => {
  for (const text of ["x".repeat(20_000), "a=".repeat(25_000), 'password="'.repeat(5_000), "Authorization: ".repeat(4_000), "--token ".repeat(6_000), "https://u:".repeat(5_000)]) {
    const started = performance.now();
    redactArgs({ text });
    const ms = performance.now() - started;
    assert.ok(ms < 60, `${text.slice(0, 12)}… (${text.length} characters) took ${Math.round(ms)} ms`);
  }
});
