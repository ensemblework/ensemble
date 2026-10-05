/**
 * Normalise a triage reply into todo rows.
 *
 * The prompt asks for {"todos":[...]}. Models also return a bare array, one
 * object per email (`todo` / `todos` on the email), a ```json fence, or the
 * same array with prose around it. A bad row is skipped. A reply that is not
 * JSON at all still throws, so the caller keeps its existing error path.
 */
import { parseModelJson } from "../runtime/model-json.js";

export interface HeuristicSource {
  id: string;
  input: {
    kind: string;
    title: string;
    text: string;
    participants?: Array<{ name?: string | null; email?: string | null }>;
    metadata?: Record<string, unknown> | null;
  };
}

export interface ModelTodo {
  id: string;
  title: string;
  priority?: string;
  due?: string | null;
  /** HH:MM when the model extracted a time. Absent means 17:00 at proposal time. */
  dueTime?: string | null;
  owner?: string;
  rationale?: string;
  excerpt?: string;
}

interface Found {
  record: Record<string, unknown>;
  inheritedId: string | null;
  path: string;
}

function warnSkipped(reason: string): void {
  console.warn(`triage skipped a todo: ${reason}`);
}

/** Keyword fallback. The reply itself stays out of the log; it can be an email. */
export function warnTriageFallback(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const why = message.startsWith("The model did not return JSON") ? "the model did not return JSON" : "the reply could not be read";
  console.warn(`triage fell back to keyword rules: ${why}`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function idOf(record: Record<string, unknown>): string | null {
  const direct = stringField(record.id) ?? stringField(record.emailId) ?? stringField(record.email_id);
  if (direct) return direct;
  const email = asRecord(record.email);
  return email ? stringField(email.id) : null;
}

function collect(value: unknown, inheritedId: string | null, path: string, asItem: boolean, found: Found[], skipped: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collect(entry, inheritedId, `${path}[${index}]`, true, found, skipped));
    return;
  }
  const record = asRecord(value);
  if (!record) {
    if (asItem) skipped.push(`${path} is not an object`);
    return;
  }
  if ("todos" in record) {
    const id = idOf(record) ?? inheritedId;
    if (Array.isArray(record.todos)) {
      collect(record.todos, id, `${path}.todos`, false, found, skipped);
      return;
    }
    skipped.push(`${path}.todos is not an array`);
    return;
  }
  if ("todo" in record) {
    const id = idOf(record) ?? inheritedId;
    if (record.todo == null) return;
    const nested = asRecord(record.todo);
    if (!nested) {
      skipped.push(`${path}.todo is not an object`);
      return;
    }
    collect(nested, id, `${path}.todo`, true, found, skipped);
    return;
  }
  if (!asItem && !idOf(record) && !stringField(record.title)) return;
  found.push({ record, inheritedId, path });
}

function chooseId(record: Record<string, unknown>, inheritedId: string | null, knownIds: ReadonlySet<string>): string | null {
  const own = idOf(record);
  if (own && knownIds.has(own)) return own;
  if (inheritedId && knownIds.has(inheritedId)) return inheritedId;
  return own ?? inheritedId;
}

function materialize(item: Found, knownIds: ReadonlySet<string>, skipped: string[]): ModelTodo | null {
  const id = chooseId(item.record, item.inheritedId, knownIds);
  if (!id) {
    skipped.push(`${item.path}: missing id`);
    return null;
  }
  if (!knownIds.has(id)) {
    skipped.push(`${item.path}: unknown id ${id}`);
    return null;
  }
  const title = stringField(item.record.title);
  if (!title) {
    skipped.push(`${item.path}: missing title for ${id}`);
    return null;
  }
  const todo: ModelTodo = { id, title };
  if (typeof item.record.priority === "string" && item.record.priority.trim()) todo.priority = item.record.priority.trim();
  if (item.record.due === null) todo.due = null;
  else if (typeof item.record.due === "string") todo.due = item.record.due;
  const dueTime = item.record.due_time ?? item.record.dueTime;
  if (dueTime === null) todo.dueTime = null;
  else if (typeof dueTime === "string" && dueTime.trim()) todo.dueTime = dueTime.trim();
  if (typeof item.record.owner === "string" && item.record.owner.trim()) todo.owner = item.record.owner.trim();
  if (typeof item.record.rationale === "string") todo.rationale = item.record.rationale;
  if (typeof item.record.excerpt === "string") todo.excerpt = item.record.excerpt;
  return todo;
}

const ASKS = /\?|\b(please|can you|could you|would you|let me know|need you|action required|by (eod|end of day|tomorrow|monday|tuesday|wednesday|thursday|friday)|asap|deadline)\b/i;

export function heuristicTodo(item: HeuristicSource): ModelTodo | null {
  const meta = item.input.metadata ?? {};
  const direct = Boolean(meta.directlyToMe || meta.mentionsMe || meta.direct);
  if (!direct || !ASKS.test(item.input.text.slice(0, 2000))) return null;
  const who = item.input.participants?.[0]?.name ?? item.input.participants?.[0]?.email ?? "them";
  const sentence = item.input.text.split(/(?<=[.?!])\s+/).find((line) => ASKS.test(line)) ?? item.input.text.slice(0, 160);
  return {
    id: item.id,
    title: item.input.kind === "email" ? `Reply to ${who}: ${item.input.title}` : `Answer ${who} on Slack`,
    priority: /asap|eod|end of day|urgent|today/i.test(item.input.text) ? "p0" : "p1",
    owner: "me",
    rationale: `${who} asked something directly.`,
    excerpt: sentence.slice(0, 300),
  };
}

/** Model todos when the reply matches, otherwise the keyword rules. A cut-off reply takes the keyword path. */
export function triageTodosFromReply(
  reply: string,
  items: HeuristicSource[],
  onInvalid?: (reason: string) => void,
): { todos: ModelTodo[]; via: "model" | "heuristic"; error?: string } {
  try {
    return { todos: readTriageTodos(reply, new Set(items.map((item) => item.id)), onInvalid), via: "model" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnTriageFallback(error);
    return { todos: items.map(heuristicTodo).filter((row): row is ModelTodo => row !== null), via: "heuristic", error: message };
  }
}

export function readTriageTodos(
  reply: unknown,
  knownIds: ReadonlySet<string>,
  onInvalid: (reason: string) => void = warnSkipped,
): ModelTodo[] {
  const value = typeof reply === "string" ? parseModelJson(reply, "triage") : reply;
  const found: Found[] = [];
  const skipped: string[] = [];
  collect(value, null, "reply", false, found, skipped);
  const todos: ModelTodo[] = [];
  for (const item of found) {
    const todo = materialize(item, knownIds, skipped);
    if (todo) todos.push(todo);
  }
  for (const reason of skipped) onInvalid(reason);
  return todos;
}
