/**
 * The page editor's schema on the server, built from `page-schema.json`, which hub-web writes
 * from its TipTap extensions. Collaborative steps (`collab.ts`) are applied with it, so the
 * server's document is exactly the one every editor holds.
 */
import { Fragment, Mark, Node, Schema, type MarkSpec, type NodeSpec } from "prosemirror-model";
import { EMPTY_PAGE, type PageDocument } from "@ensemble/shared-types";
import { PAGE_SCHEMA, UNDEFINED_DEFAULT, type PageSchemaSpec } from "@ensemble/shared-types/page-schema";

function specOf(spec: Record<string, unknown>): Record<string, unknown> {
  const attrs = spec.attrs as Record<string, Record<string, unknown>> | undefined;
  if (!attrs) return spec;
  return {
    ...spec,
    attrs: Object.fromEntries(Object.entries(attrs).map(([name, attr]) => [name, attr.undefinedDefault === UNDEFINED_DEFAULT.undefinedDefault ? { default: undefined } : attr])),
  };
}

export function buildPageSchema(spec: PageSchemaSpec = PAGE_SCHEMA): Schema {
  return new Schema({
    topNode: spec.topNode,
    nodes: Object.fromEntries(spec.nodes.map(([name, node]) => [name, specOf(node) as NodeSpec])),
    marks: Object.fromEntries(spec.marks.map(([name, mark]) => [name, specOf(mark) as MarkSpec])),
  });
}

export const pageSchema = buildPageSchema();

/**
 * Saved pages can hold mark combinations the schema refuses (an import's bold inline code).
 * Keeps the marks each parent allows, as the editor does when it takes in a document.
 */
function allowedMarks(node: Node): Node {
  if (node.isLeaf) return node;
  const children: Node[] = [];
  node.forEach((child) => {
    let marks = Mark.none;
    for (const mark of child.marks) if (node.type.allowsMarkType(mark.type)) marks = mark.addToSet(marks);
    const kept = Mark.sameSet(marks, child.marks) ? child : child.mark(marks);
    children.push(allowedMarks(kept));
  });
  return node.copy(Fragment.from(children));
}

type Json = { type?: unknown; content?: unknown; marks?: unknown; [key: string]: unknown };

/** Drops marks and nodes the schema does not know; a node's children stay where it was. */
function repair(schema: Schema, value: Json): Json[] {
  if (!value || typeof value !== "object") return [];
  const type = typeof value.type === "string" ? value.type : "";
  const children = Array.isArray(value.content) ? (value.content as Json[]).flatMap((child) => repair(schema, child)) : undefined;
  if (!schema.nodes[type]) return children ?? [];
  const marks = Array.isArray(value.marks) ? (value.marks as Json[]).filter((mark) => typeof mark?.type === "string" && schema.marks[mark.type as string]) : undefined;
  return [{ ...value, ...(children ? { content: children } : {}), ...(marks ? { marks } : {}) }];
}

/**
 * A stored page as a document of this schema. Null content is the empty page. Throws only when
 * not even a repaired copy fits.
 */
export function pageDoc(content: unknown, schema: Schema = pageSchema): Node {
  const json = (content ?? EMPTY_PAGE) as Json;
  let doc: Node;
  try {
    doc = schema.nodeFromJSON(json);
  } catch {
    doc = schema.nodeFromJSON({ ...json, type: schema.topNodeType.name, content: repair(schema, { ...json, type: schema.topNodeType.name })[0]?.content ?? [] });
  }
  doc = allowedMarks(doc);
  return doc.childCount ? doc : schema.nodeFromJSON(EMPTY_PAGE);
}

export function docJson(doc: Node): PageDocument {
  return doc.toJSON() as PageDocument;
}
