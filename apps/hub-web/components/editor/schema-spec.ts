import { getSchema } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import { UNDEFINED_DEFAULT, type PageSchemaSpec } from "@ensemble/shared-types/page-schema";
import { editorExtensions } from "./extensions";

/** The data parts of one node or mark spec: everything but parsing, rendering and callbacks. */
function plain(spec: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(spec)) {
    if (value === undefined || typeof value === "function" || key === "parseDOM") continue;
    if (key === "attrs" && value && typeof value === "object") {
      out.attrs = Object.fromEntries(
        Object.entries(value as Record<string, Record<string, unknown>>).map(([name, attr]) => {
          if (!Object.prototype.hasOwnProperty.call(attr, "default")) return [name, {}];
          return [name, attr.default === undefined ? { ...UNDEFINED_DEFAULT } : { default: attr.default }];
        }),
      );
      continue;
    }
    out[key] = value;
  }
  return JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
}

export function schemaSpec(schema: Schema): PageSchemaSpec {
  const nodes: PageSchemaSpec["nodes"] = [];
  const marks: PageSchemaSpec["marks"] = [];
  schema.spec.nodes.forEach((name, spec) => nodes.push([name, plain(spec)]));
  schema.spec.marks.forEach((name, spec) => marks.push([name, plain(spec)]));
  return { topNode: schema.spec.topNode ?? "doc", nodes, marks };
}

/** The schema of the page editor (`editorExtensions`), built without a browser. */
export function editorSchemaSpec(): PageSchemaSpec {
  return schemaSpec(getSchema(editorExtensions(() => [], "")));
}
