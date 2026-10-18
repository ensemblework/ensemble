import assert from "node:assert/strict";
import test from "node:test";
import { addressLink, isExternalHref, linkPieces, trimAddress } from "./linkify";

const links = (text: string) => linkPieces(text).filter((piece) => piece.kind === "link").map((piece) => (piece.kind === "link" ? [piece.text, piece.href] : []));

test("bare http(s) URLs keep their query and fragment, and the text around them stays", () => {
  const notion = "https://app.notion.com/p/Launch-plan-2f3c9a1b?pvs=204";
  assert.deepEqual(linkPieces(`See ${notion} for the plan`), [
    { kind: "text", text: "See " },
    { kind: "link", text: notion, href: notion },
    { kind: "text", text: " for the plan" },
  ]);
  assert.deepEqual(links("http://localhost:3000/tasks?view=board#top"), [["http://localhost:3000/tasks?view=board#top", "http://localhost:3000/tasks?view=board#top"]]);
  assert.deepEqual(links("https://de.wikipedia.org/wiki/Straße"), [["https://de.wikipedia.org/wiki/Straße", "https://de.wikipedia.org/wiki/Straße"]]);
});

test("sentence punctuation and unbalanced closing brackets or quotes stay outside the link", () => {
  assert.deepEqual(links("Read https://example.com/docs."), [["https://example.com/docs", "https://example.com/docs"]]);
  assert.deepEqual(links("Is it https://example.com/a?"), [["https://example.com/a", "https://example.com/a"]]);
  assert.deepEqual(links("(see https://example.com/x)"), [["https://example.com/x", "https://example.com/x"]]);
  assert.deepEqual(links("“https://example.com/q”,"), [["https://example.com/q", "https://example.com/q"]]);
  assert.deepEqual(links("[https://example.com/b]"), [["https://example.com/b", "https://example.com/b"]]);
  assert.deepEqual(links("Done: https://example.com/c; next https://example.com/d!"), [
    ["https://example.com/c", "https://example.com/c"],
    ["https://example.com/d", "https://example.com/d"],
  ]);
  const pieces = linkPieces("(see https://example.com/x).");
  assert.deepEqual(pieces.map((piece) => piece.text), ["(see ", "https://example.com/x", ")."]);
});

test("balanced parentheses stay part of the URL", () => {
  const wiki = "https://en.wikipedia.org/wiki/Python_(programming_language)";
  assert.deepEqual(links(wiki), [[wiki, wiki]]);
  assert.deepEqual(links(`(${wiki})`), [[wiki, wiki]]);
  assert.deepEqual(links(`Also ${wiki}.`), [[wiki, wiki]]);
});

test("www hosts get https, emails and mailto get mailto", () => {
  assert.deepEqual(links("Go to www.example.com/path."), [["www.example.com/path", "https://www.example.com/path"]]);
  assert.deepEqual(links("Mail mira@fieldnote.example."), [["mira@fieldnote.example", "mailto:mira@fieldnote.example"]]);
  assert.deepEqual(links("mailto:ben@fieldnote.example"), [["mailto:ben@fieldnote.example", "mailto:ben@fieldnote.example"]]);
  assert.deepEqual(links("first.last+tag@mail.fieldnote.example"), [["first.last+tag@mail.fieldnote.example", "mailto:first.last+tag@mail.fieldnote.example"]]);
});

test("other schemes, half addresses and mention tokens are not links", () => {
  assert.deepEqual(links("javascript:alert(1) data:text/html,hi file:///etc/passwd ftp://example.com"), []);
  assert.deepEqual(links("https:// and www. and www.example and user@host"), []);
  assert.deepEqual(links("@people:Mira Chen and @task:Ship it"), []);
  assert.deepEqual(links("v1.2.3 e.g. file.txt example.com"), []);
  assert.deepEqual(links("xhttps://example.com"), []);
  assert.deepEqual(links('{"url":"https://example.com/a","next":"https://example.com/b"}'), [
    ["https://example.com/a", "https://example.com/a"],
    ["https://example.com/b", "https://example.com/b"],
  ]);
  assert.deepEqual(links("<https://example.com/angle>"), [["https://example.com/angle", "https://example.com/angle"]]);
  assert.deepEqual(links("`https://example.com/tick`"), [["https://example.com/tick", "https://example.com/tick"]]);
});

test("helpers: trimming, a single address, and which addresses leave the app", () => {
  assert.equal(trimAddress("https://example.com/a)),"), "https://example.com/a");
  assert.equal(trimAddress("https://example.com/(a)"), "https://example.com/(a)");
  assert.equal(addressLink("https://."), null);
  assert.deepEqual(addressLink("www.example.org."), { text: "www.example.org", href: "https://www.example.org" });
  assert.equal(isExternalHref("https://example.com"), true);
  assert.equal(isExternalHref("//evil.example"), true);
  assert.equal(isExternalHref("/tasks/1"), false);
});
