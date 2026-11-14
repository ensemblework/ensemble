import assert from "node:assert/strict";
import test from "node:test";
import { mcpRequestFromLoginNext } from "./mcp-oauth.js";

test("only a single validated MCP request can be carried through sign-in", () => {
  const request = `ens_oauth_request_${"x".repeat(43)}`;
  assert.equal(mcpRequestFromLoginNext(`/oauth?request=${request}`), request);
  for (const target of [null, "https://evil.example", `//evil.example/oauth?request=${request}`, `/oauth?request=${request}&next=https://evil.example`, `/oauth?request=${request}#other`, "/oauth?request=not-a-request", "/today"]) {
    assert.equal(mcpRequestFromLoginNext(target), null);
  }
});
