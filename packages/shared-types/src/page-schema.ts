/**
 * The page editor's ProseMirror schema as data: node and mark names in order, with their content
 * expressions, groups, attributes and defaults, and no rendering. hub-web writes
 * `page-schema.json` from its live TipTap extensions (`pnpm --filter @ensemble/hub-web
 * page-schema`) and a hub-web test fails when the two drift. hub-api builds the same schema from
 * it (`src/pages/schema.ts`) to apply collaborative edits exactly as the editor does.
 */
import file from "./page-schema.json" with { type: "json" };

export type PageSchemaSpec = {
  topNode: string;
  nodes: Array<[name: string, spec: Record<string, unknown>]>;
  marks: Array<[name: string, spec: Record<string, unknown>]>;
};

/** Stands in for an attribute whose default is `undefined`, which JSON cannot hold. */
export const UNDEFINED_DEFAULT = { undefinedDefault: true } as const;

export const PAGE_SCHEMA = file as unknown as PageSchemaSpec;
