/**
 * The delivery check's English phrase list (node/delivery-claims.ts): which replies say that something reached
 * the chat, what backs each claim, and how a claim nothing backs is taken out of the reply.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { checkDelivery, claimFeedback, deliveredWith, deliveryClaims, heldCaptures } from "./delivery-claims.js";

const kinds = (text: string) => deliveryClaims(text).map((claim) => claim.kind);
const none = { pictures: 0, videos: 0, files: 0 };

test("a reply that says a picture, video or file is here, attached, sent or shared makes a claim", () => {
  assert.deepEqual(kinds("Here’s the screenshot of the status page."), ["screenshot"]);
  assert.deepEqual(kinds("The screenshot of example.com is attached."), ["screenshot"]);
  assert.deepEqual(kinds("**Screenshot:** attached below"), ["screenshot"]);
  assert.deepEqual(kinds("See the screenshot below."), ["screenshot"]);
  assert.deepEqual(kinds("I've sent you the screenshots."), ["screenshot"]);
  assert.deepEqual(kinds("Done. I added the task and here is a picture of the board."), ["picture"]);
  assert.deepEqual(kinds("Here's the recording of the calculator."), ["video"]);
  assert.deepEqual(kinds("The summary is attached."), ["file"]);
  assert.deepEqual(kinds("I've attached the report."), ["file"]);
  assert.deepEqual(kinds("I've shared the report with you."), ["file"]);
  assert.deepEqual(kinds("Created and shared the one-page Markdown summary of the field trial report."), ["file"]);
  assert.deepEqual(deliveryClaims("Attached is report.md with the numbers.").map((claim) => claim.noun), ["report.md"], "a file's name, dots and all");
  assert.deepEqual(kinds("7 × 6 = 42. I've attached the screenshot. The page shows 3 services."), ["screenshot"], "one claim, in its own sentence");
});

test("what is not a claim: a denial, a question, a plan, the owner's own file, another place, and text written in the reply", () => {
  for (const text of [
    "No screenshot is attached: the browser did not start.",
    "I couldn't attach the recording.",
    "Should I send you the file?",
    "If the build passes, I'll send the report.",
    "The PDF you attached says 42.",
    "I've attached the screenshot to the task.",
    "I've shared the doc with Mira.",
    "I've sent the report to Ben by email.",
    "I've uploaded the file to your Drive.",
    "I've posted the report in #general.",
    "Here is the report on Q3: revenue grew.",
    "Here's a summary of the meeting:",
    "Here are both.",
  ]) {
    assert.deepEqual(deliveryClaims(text), [], text);
  }
});

test("a claim holds when what it names reached the chat: a picture, a video, any file or a link to one; a capture held for the owner's card counts", () => {
  assert.equal(checkDelivery("Here is the screenshot.", deliveredWith([{ kind: "screenshot" }], "")), null);
  assert.equal(checkDelivery("Here is the screenshot.", deliveredWith(heldCaptures([{ data: { evidence: [{ id: "e1", kind: "screenshot", held: true }] } }]), "")), null, "held for the owner's preview card");
  assert.ok(checkDelivery("Here is the screenshot.", deliveredWith([{ kind: "report" }], "")), "a file is not a picture");
  assert.ok(checkDelivery("Here's the video.", deliveredWith([{ kind: "screenshot" }], "")), "a picture is not a video");
  assert.equal(checkDelivery("I've attached report.md.", deliveredWith([{ kind: "report" }], "")), null);
  const linked = "I've attached the report: [report.md](ensemble://file/0d7f6c2e-4a5b-4c3d-8e9f-0a1b2c3d4e5f).";
  assert.equal(checkDelivery(linked, deliveredWith([], linked)), null, "a link to the saved file");
  assert.equal(checkDelivery("I couldn't take the screenshot: the page did not load.", deliveredWith([], "")), null);
});

test("a claim nothing backs: one round of feedback, then the claim goes from the reply and a plain note says what was not attached", () => {
  const only = checkDelivery("Here are the screenshots.", none)!;
  assert.equal(only.count, 1);
  assert.equal(only.feedback, "You said the screenshots are attached, but nothing reached the chat. Attach them with the right tool, or correct your reply.");
  assert.equal(only.corrected, "No screenshot was attached.", "a sentence that only made the claim goes");

  const mixed = checkDelivery("7 × 6 = 42.\nHere is the screenshot.\nThe display shows 42.", none)!;
  assert.equal(mixed.corrected, "7 × 6 = 42.\nThe display shows 42.\n\nNo screenshot was attached.");

  const kept = checkDelivery("Here’s the screenshot of the status page: it shows 3 services up and 1 down.", none)!;
  assert.equal(kept.corrected, "Here’s the screenshot of the status page: it shows 3 services up and 1 down.\n\nNo screenshot was attached.", "a sentence that says more stays");

  const two = checkDelivery("I've attached report.md. Here's the recording.", none)!;
  assert.equal(two.count, 2);
  assert.equal(two.corrected, "No file was attached. No video was attached.");
  assert.equal(claimFeedback(deliveryClaims("I've attached report.md.")), "You said report.md is attached, but nothing reached the chat. Attach it with the right tool, or correct your reply.");
  for (const text of [only.feedback, only.corrected, mixed.corrected, two.corrected]) assert.doesNotMatch(text, /\u2014|--/, "no long dashes");
});
