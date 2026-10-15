import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { PAGE_SCHEMA } from "@ensemble/shared-types/page-schema";
import { editorSchemaSpec } from "./schema-spec";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });

test("hub-api's copy of the page schema matches the editor's extensions", () => {
  assert.deepEqual(
    editorSchemaSpec(),
    PAGE_SCHEMA,
    "The editor schema changed. Run `pnpm --filter @ensemble/hub-web page-schema` and commit packages/shared-types/src/page-schema.json.",
  );
});
