import assert from "node:assert/strict";
import { test } from "node:test";
import { localWebOrigin } from "./local-web.js";

test("serve mode takes only a website on localhost", () => {
  assert.equal(localWebOrigin("http://localhost:3310/"), "http://localhost:3310");
  for (const origin of ["https://node.ensemblework.com", "https://node-test.ensemblework.com", "http://127.0.0.1:3310", "http://localhost", "http://localhost:3310/r/room", "ftp://localhost:3310"]) {
    assert.throws(() => localWebOrigin(origin), /localhost:<port>|origin/, origin);
  }
});
