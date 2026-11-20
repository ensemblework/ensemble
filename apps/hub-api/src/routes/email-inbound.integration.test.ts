import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { createHttpHarness, type HttpHarness } from "../test/http.js";

const noReply = "Ensemble <no-reply@mail.example.com>";
const support = "Ensemble <support@example.com>";
const inbox = "operator@example.net";
const signingKey = randomBytes(32);
const secret = `whsec_${signingKey.toString("base64")}`;
const emailIds: string[] = [];
let harness: HttpHarness;

const rawEmail = [
  "From: \"Mira & Team\" <mira@example.net>",
  "To: help@example.com",
  "Reply-To: tickets@example.net",
  "Subject: A support question",
  "MIME-Version: 1.0",
  "Content-Type: multipart/related; boundary=mime-boundary",
  "",
  "--mime-boundary",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Message with <img src=\"cid:picture\"></p>",
  "--mime-boundary",
  "Content-Type: image/png; name=pic.png",
  "Content-ID: <picture>",
  "Content-Disposition: inline; filename=pic.png",
  "Content-Transfer-Encoding: base64",
  "",
  "cGljdHVyZQ==",
  "--mime-boundary--",
  "",
].join("\r\n");

before(async () => {
  process.env.EMAIL_PROVIDER = "resend";
  process.env.EMAIL_API_KEY = "test-account-key";
  process.env.EMAIL_FROM = noReply;
  process.env.EMAIL_FROM_SUPPORT = support;
  process.env.EMAIL_FORWARD_TO = inbox;
  process.env.EMAIL_INBOUND_WEBHOOK_SECRET = secret;
  process.env.EMAIL_INBOUND_API_KEY = "test-inbound-key";
  harness = await createHttpHarness();
});

after(async () => {
  if (process.env.ENSEMBLE_TEST_DATABASE_URL) {
    await harness.prisma.inboundEmailReceipt.deleteMany({ where: { id: { in: emailIds } } });
  }
  await harness?.close();
});

function event(details: Record<string, unknown> = {}) {
  const email_id = randomUUID();
  emailIds.push(email_id);
  return { type: "email.received", data: { email_id, from: "mira@example.net", to: ["help@example.com"], ...details } };
}

function signature(payload: string, timestamp = new Date()) {
  const id = `msg_${randomUUID()}`;
  const seconds = String(Math.floor(timestamp.getTime() / 1000));
  const signature = createHmac("sha256", signingKey).update(`${id}.${seconds}.${payload}`).digest("base64");
  return {
    "svix-id": id,
    "svix-timestamp": seconds,
    "svix-signature": `v1,${signature}`,
  };
}

function post(payload: string, headers: Record<string, string> = signature(payload)) {
  return harness.app.inject({ method: "POST", url: "/api/email/inbound", headers: { "content-type": "application/json", ...headers }, payload });
}

test("inbound mail is 404 without configuration, even before parsing the request", async (t) => {
  const { buildApp } = await import("../app.js");
  delete process.env.EMAIL_INBOUND_WEBHOOK_SECRET;
  const app = await buildApp({ logger: false });
  process.env.EMAIL_INBOUND_WEBHOOK_SECRET = secret;
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/api/email/inbound", payload: "not JSON" });
  assert.equal(response.statusCode, 404);
});

test("rejects unsigned, tampered, stale and invalid webhooks before contacting Resend", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected provider call"); });
  const payload = JSON.stringify(event());
  assert.equal((await post(payload, {})).statusCode, 400);
  assert.equal((await post(`${payload} `, signature(payload))).statusCode, 400);
  assert.equal((await post(payload, signature(payload, new Date(Date.now() - 301_000)))).statusCode, 400);
  assert.equal((await post(JSON.stringify({ type: "email.received", data: { email_id: "bad-id" } }))).statusCode, 400);
  assert.equal(fetch.mock.callCount(), 0);
});

test("ignores the inbox sender, the no-reply recipient, other domains and other event types", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected provider call"); });
  for (const payload of [
    event({ from: "Operator <OPERATOR@example.net>" }),
    event({ to: ["Ensemble <NO-REPLY@mail.example.com>"] }),
    event({ to: ["support@other.example.com"] }),
    { type: "email.sent" },
  ]) {
    assert.equal((await post(JSON.stringify(payload))).statusCode, 200);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("preserves sender, Reply-To and inline attachments, retries failures, then deduplicates by email ID", async (t) => {
  const message = event({ to: ["undisclosed-recipients:;"], received_for: ["Outreach <OUTREACH@example.com>"] });
  const id = message.data.email_id;
  const payload = JSON.stringify(message, null, 2);
  const rawUrl = "https://resend-download.example.net/message";
  const sendKeys: string[] = [];
  const sent: unknown[] = [];
  let downloads = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `https://api.resend.com/emails/receiving/${id}?html_format=cid`) {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-inbound-key");
      return Response.json({ raw: { download_url: rawUrl } });
    }
    if (url === rawUrl) {
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      downloads++;
      return new Response(rawEmail);
    }
    assert.equal(url, "https://api.resend.com/emails");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-inbound-key");
    sendKeys.push(headers.get("idempotency-key") ?? "");
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({}, { status: sent.length === 1 ? 429 : 200 });
  });

  assert.equal((await post(payload)).statusCode, 502);
  assert.equal(await harness.prisma.inboundEmailReceipt.findUnique({ where: { id } }), null);
  assert.equal((await post(payload)).statusCode, 200);
  assert.equal((await post(payload)).statusCode, 200);
  assert.equal(downloads, 2);
  assert.deepEqual(sendKeys, [`inbound/${id}`, `inbound/${id}`]);
  assert.deepEqual(sent[0], sent[1]);
  assert.deepEqual(sent[1], {
    from: support,
    to: [inbox],
    subject: "A support question",
    reply_to: ["tickets@example.net"],
    html: "<p>Original sender: Mira &amp; Team &lt;mira@example.net&gt;<br>Received for: outreach@example.com</p><p>Message with <img src=\"cid:picture\"></p>",
    attachments: [{ filename: "pic.png", content: "cGljdHVyZQ==", content_type: "image/png", content_id: "picture" }],
  });
});

test("account verification, password reset and passkey codes use the no-reply sender and key", async (t) => {
  const { sendAccountEmail, sendPasskeyCode } = await import("../lib/auth-email.js");
  const user = await harness.asUser();
  const sent: Array<{ from: string; to: string[]; subject: string }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-account-key");
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({});
  });
  await sendAccountEmail(harness.prisma, user, "verify");
  await sendAccountEmail(harness.prisma, user, "reset");
  await sendPasskeyCode(user, "TEST12");
  assert.equal(sent.length, 3);
  for (const message of sent) {
    assert.equal(message.from, noReply);
    assert.deepEqual(message.to, [user.email]);
  }
  assert.match(sent[0]!.subject, /^Your Ensemble code: /);
  assert.equal(sent[1]!.subject, "Reset your Ensemble password");
  assert.equal(sent[2]!.subject, "Your Ensemble code to add a passkey: TEST12");
});
