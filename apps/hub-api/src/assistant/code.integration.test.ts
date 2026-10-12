import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHttpHarness } from "../test/http.js";

const harness = await createHttpHarness();
const a = await harness.asUser();
after(() => harness.close());

test("the hosted site refuses Ensemble Code sessions: they run on the person's own computer", async () => {
  for (const url of ["/api/assistant/apply", "/api/assistant/turn"]) {
    const response = await a.inject({
      method: "POST",
      url,
      payload: JSON.stringify(url.endsWith("apply") ? { calls: [{ name: "ensemble_start_agent", input: { title: "x" } }], code: { folder: "/tmp" } } : { message: "hi", code: { folder: "/tmp" } }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(response.statusCode, 409, `${url}: ${response.body}`);
    assert.match(response.json().error, /own computer/);
  }
});
