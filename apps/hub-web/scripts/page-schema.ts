/**
 * Writes the page editor's schema to packages/shared-types/src/page-schema.json, which hub-api
 * builds its collaborative-editing schema from. Run it after changing an editor extension:
 * `pnpm --filter @ensemble/hub-web page-schema`.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import "../components/ui-test-dom";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });

void import("../components/editor/schema-spec").then(({ editorSchemaSpec }) => {
  const output = resolve(__dirname, "../../../packages/shared-types/src/page-schema.json");
  writeFileSync(output, `${JSON.stringify(editorSchemaSpec(), null, 2)}\n`);
  console.log(`Wrote ${output}`);
  process.exit(0);
});
