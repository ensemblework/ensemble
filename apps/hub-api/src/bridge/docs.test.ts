import assert from "node:assert/strict";
import test from "node:test";
import { DOCS_HOME } from "@ensemble/docs/search";
import { publishedDocs } from "./docs.js";

const index = {
  version: 1,
  pages: [{
    title: "Context Bridge",
    path: "/context_bridge/",
    sections: [{ heading: "Three ways to reach it", url: `${DOCS_HOME}context_bridge/#three-ways-to-reach-it`, text: "Editors use the Ensemble CLI, the hosted URL, or a source build." }],
  }],
};

test("reads and caches only the public index, never sending an ens_ key", async () => {
  let calls = 0;
  const docs = publishedDocs(async (input, init) => {
    calls++;
    assert.equal(input, `${DOCS_HOME}search-index.json`);
    assert.deepEqual(init?.headers, { accept: "application/json" });
    assert.equal(init?.redirect, "error");
    return Response.json(index);
  });
  const known = await docs("Three ways");
  assert.equal(known.found, true);
  assert.equal(known.results[0]?.url, index.pages[0]!.sections[0]!.url);
  const unknown = await docs("zzzzquasar");
  assert.equal(unknown.found, false);
  assert.deepEqual(unknown.results, []);
  assert.equal(calls, 1);
});

test("a missing or invalid publication is an error, not an invented answer or a cached miss", async () => {
  let calls = 0;
  const docs = publishedDocs(async () => {
    calls++;
    if (calls === 1) return new Response("Unavailable", { status: 503 });
    if (calls === 2) return Response.json({ ...index, pages: [{ ...index.pages[0], sections: [{ ...index.pages[0]!.sections[0], url: "https://elsewhere.example/guide" }] }] });
    return Response.json(index);
  });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(docs("Three ways"), (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /Published documentation could not be loaded/);
      return true;
    });
  }
  assert.equal((await docs("Three ways")).found, true);
  assert.equal(calls, 3);
});
