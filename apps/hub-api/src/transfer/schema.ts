/**
 * What moving a computer's local-only data into an Ensemble account copies (docs/DESKTOP.md §1.3):
 * which tables, in which order, and what each column means for the move — the account's own columns,
 * references to other rows, unique keys. Both sides read this: the computer exports with it, the
 * account's server checks every row against it.
 */
import { Prisma } from "@prisma/client";

/**
 * Copied in this order, parents first. Anything not listed stays on the computer: sign-ins, keys and
 * connected apps (encrypted with this computer's own key), agent runs and their logs, undo history,
 * the tamper-evident activity ledger, and caches the account rebuilds itself.
 */
export const TRANSFER_TABLES = [
  "preferences",
  "context_suppressions",
  "widget_layouts",
  "metric_baselines",
  "skills",
  "skill_versions",
  "skill_feedback",
  "people",
  "person_identities",
  "repos",
  "projects",
  "project_links",
  "project_people",
  "project_repos",
  "deliverables",
  "meeting_sessions",
  "artifacts",
  "meeting_notes",
  "context_documents",
  "extractions",
  "artifact_chunks",
  "tasks",
  "task_transitions",
  "completion_records",
  "page_boards",
  "task_pages",
  "task_page_mentions",
  "page_discussions",
  "page_revisions",
  "page_templates",
  "block_diagrams",
  "block_diagram_revisions",
  "diagram_links",
  "plot_datasets",
  "plots",
  "assistant_conversations",
  "assistant_messages",
  "assistant_routines",
  "assistant_workflows",
  "watchers",
  "decision_rules",
  "private_reminders",
  "timetable_slots",
  "court_holidays",
  "attendance_marks",
  "objectives",
  "deploy_events",
  "part_rows",
  "test_results",
  "citation_links",
  "grading_rows",
  "metric_events",
] as const;

export type TransferTable = (typeof TRANSFER_TABLES)[number];

const TABLES = new Set<string>(TRANSFER_TABLES);
export function isTransferTable(name: string): name is TransferTable {
  return TABLES.has(name);
}

/** Fields naming an account: always the receiving account after a move, whatever the row said. */
const ACCOUNT_FIELD = /^(userId|spaceId|ownerId|accountId|[a-z]+AccountId)$/;

export type Reference = { column: string; table: string; nullable: boolean };

export type TableShape = {
  table: TransferTable;
  model: string;
  /** Primary key columns (`id` for most tables; two columns for a link table). */
  key: string[];
  /** The column holding the owning account, when the table has one. */
  account: string | null;
  /** Every column naming an account (owner, author, requester…). */
  accountColumns: string[];
  /** Foreign keys to other rows. `table` may be one that stays behind. */
  references: Reference[];
  /** Unique keys other than the primary key, as column lists. */
  uniques: string[][];
  /** For a table without an account column: the reference to the row that owns it. */
  owner: Reference | null;
};

type DmmfModel = (typeof Prisma.dmmf.datamodel.models)[number];

function tableOf(model: DmmfModel): string {
  return model.dbName ?? model.name;
}

function columnOf(model: DmmfModel, field: string): string {
  const found = model.fields.find((item) => item.name === field);
  if (!found) throw new Error(`Unknown field ${model.name}.${field} in the transfer schema.`);
  return found.dbName ?? found.name;
}

let shapes: Map<string, TableShape> | null = null;

export function transferShapes(): Map<string, TableShape> {
  if (shapes) return shapes;
  const models = Prisma.dmmf.datamodel.models;
  const byName = new Map(models.map((model) => [model.name, model]));
  const next = new Map<string, TableShape>();
  for (const model of models) {
    const table = tableOf(model);
    if (!isTransferTable(table)) continue;
    const key = model.primaryKey ? model.primaryKey.fields.map((field) => columnOf(model, field)) : model.fields.filter((field) => field.isId).map((field) => field.dbName ?? field.name);
    const accountColumns = model.fields.filter((field) => field.kind === "scalar" && field.type === "String" && !field.isList && ACCOUNT_FIELD.test(field.name)).map((field) => field.dbName ?? field.name);
    const account = model.fields.some((field) => field.name === "userId" && field.kind === "scalar") ? columnOf(model, "userId") : null;
    const references: Reference[] = [];
    for (const field of model.fields) {
      if (field.kind !== "object" || field.relationFromFields?.length !== 1) continue;
      const target = byName.get(field.type);
      if (!target) continue;
      const scalar = model.fields.find((item) => item.name === field.relationFromFields![0]);
      const column = columnOf(model, field.relationFromFields[0]!);
      if (accountColumns.includes(column)) continue;
      references.push({ column, table: tableOf(target), nullable: !scalar?.isRequired });
    }
    const uniques = [
      ...model.uniqueFields.map((fields) => fields.map((field) => columnOf(model, field))),
      ...model.fields.filter((field) => field.isUnique && !field.isId).map((field) => [field.dbName ?? field.name]),
    ];
    const owner = account ? null : (references.find((reference) => !reference.nullable && isTransferTable(reference.table)) ?? null);
    if (!account && !owner) throw new Error(`The transfer table ${table} has no owning account or parent.`);
    next.set(table, { table, model: model.name, key, account, accountColumns, references, uniques, owner });
  }
  for (const table of TRANSFER_TABLES) if (!next.has(table)) throw new Error(`The transfer table ${table} is not in the schema.`);
  shapes = next;
  return next;
}

export function shapeOf(table: TransferTable): TableShape {
  return transferShapes().get(table)!;
}

export function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error("Unexpected database identifier in the transfer schema.");
  return `"${value}"`;
}

const HAS_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Replaces every id in `map` anywhere in a value: columns, arrays, JSON documents, and links inside text. */
export function remapIds<T>(value: T, map: ReadonlyMap<string, string>): T {
  if (!map.size) return value;
  if (typeof value === "string") {
    return (HAS_UUID.test(value) ? value.replace(UUIDS, (id) => map.get(id.toLowerCase()) ?? id) : value) as T;
  }
  if (Array.isArray(value)) return value.map((item) => remapIds(item, map)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapIds(item, map)])) as T;
  }
  return value;
}
