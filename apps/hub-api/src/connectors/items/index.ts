/**
 * App items across a person's connected apps: which apps can be searched, search
 * and read, attach an item to a task or project (stored as an Artifact so the
 * assistant, agents, search and the editor bridge all see it), turn an item into a
 * task, add the app's people, and post an update back on an issue.
 *
 * Every call uses the person's own connection (connectors/tokens.ts). Reads are
 * shown as untrusted text; writes back to an app happen only on an explicit press.
 */
import type { ArtifactKind, Prisma, PrismaClient, TaskSource } from "@prisma/client";
import { CONNECTOR_CATALOG, TASK_LIKE_KINDS, type AppItem, type AppItemContent, type AppItemKind, type AppItemSourceInfo, type AttachedAppItem } from "@ensemble/shared-types";
import { prisma as defaultPrisma } from "../../lib/prisma.js";
import { appendLedger } from "../../lib/ledger.js";
import { isGuestIn } from "../../sharing/context.js";
import type { AccountProvider } from "../accounts.js";
import { redact, upsertPerson } from "../ingest.js";
import { ConnectorNotConnectedError, providerAccessToken, type ProviderToken } from "../tokens.js";
import { tooLarge } from "./http.js";
import { ITEM_SOURCES } from "./registry.js";
import { DEFAULT_SEARCH_LIMIT, ItemError, MAX_DOWNLOAD_BYTES, MAX_ITEM_TEXT, MAX_PEOPLE, MAX_SEARCH_LIMIT, type ItemContext, type ItemDownload, type ItemSource } from "./types.js";

export { ItemError } from "./types.js";

type Db = PrismaClient;

let fetchImpl: typeof fetch = (...args) => fetch(...args);

/** Tests replace the network; production uses global fetch. */
export function setItemFetchForTests(next: typeof fetch | null): void {
  fetchImpl = next ?? ((...args) => fetch(...args));
}

export function itemSource(id: string): ItemSource | undefined {
  return ITEM_SOURCES.find((source) => source.id === id);
}

function catalogFor(source: ItemSource) {
  return CONNECTOR_CATALOG.find((entry) => entry.id === source.id) ?? CONNECTOR_CATALOG.find((entry) => entry.provider === source.provider);
}

/** The catalog says what the store promises; an app's source must also implement it. */
function info(source: ItemSource): AppItemSourceInfo {
  const entry = catalogFor(source);
  return {
    id: source.id,
    name: entry?.name ?? source.label,
    logo: entry?.logo ?? source.id,
    kinds: [...source.kinds],
    people: Boolean(source.people && entry?.items?.people),
    comments: Boolean(source.comment && entry?.items?.comments),
  };
}

/** Apps this person connected that Ensemble can search. Reads only the non-secret columns. */
export async function connectedItemSources(userId: string, db: Db = defaultPrisma): Promise<AppItemSourceInfo[]> {
  if (isGuestIn(userId)) return [];
  const providers = [...new Set(ITEM_SOURCES.map((source) => source.provider))];
  const rows = await db.authToken.findMany({ where: { userId, provider: { in: providers } }, select: { provider: true, scopes: true, meta: true } });
  const have = new Map(rows.map((row) => [row.provider, row]));
  return ITEM_SOURCES.filter((source) => {
    const row = have.get(source.provider);
    if (!row) return false;
    if (!source.usable) return true;
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    return source.usable({ token: "", account: null, scopes: row.scopes, extra: Object.fromEntries(Object.entries(meta).map(([key, value]) => [key, String(value)])), meta });
  }).map(info);
}

async function contextFor(userId: string, source: ItemSource, signal?: AbortSignal): Promise<ItemContext> {
  if (isGuestIn(userId)) throw new ItemError("Connected apps belong to the space's owner.", 403);
  const token = await providerAccessToken(userId, source.provider as AccountProvider);
  if (!token) throw new ConnectorNotConnectedError(source.provider as AccountProvider, `${source.label} is not connected. Connect it in Settings → Connections.`);
  if (source.usable && !source.usable(token)) {
    throw new ConnectorNotConnectedError(source.provider as AccountProvider, `${source.label} is connected without the access this needs. Check it in Settings → Connections.`);
  }
  return { userId, token, fetch: fetchImpl, signal: signal ?? AbortSignal.timeout(60_000) };
}

function requireSource(id: string): ItemSource {
  const source = itemSource(id);
  if (!source) throw new ItemError(`Ensemble cannot search ${id} yet.`, 400);
  return source;
}

const clampLimit = (limit: number | undefined) => Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.round(limit ?? DEFAULT_SEARCH_LIMIT)));

export interface SearchResult {
  items: AppItem[];
  /** Apps that failed, with a message to show. The others still answered. */
  errors: Array<{ source: string; message: string }>;
}

/** Searches one app, or every connected app at once (a few hits from each). */
export async function searchItems(userId: string, input: { source?: string; q: string; kind?: AppItemKind; limit?: number }): Promise<SearchResult> {
  const q = input.q.trim().slice(0, 300);
  const limit = clampLimit(input.limit);
  const sources = input.source ? [requireSource(input.source)] : (await connectedItemSources(userId)).map((row) => requireSource(row.id));
  const errors: SearchResult["errors"] = [];
  const perSource = input.source ? limit : Math.max(3, Math.ceil(limit / Math.max(1, sources.length)) + 2);
  const results = await Promise.all(
    sources.map(async (source) => {
      if (input.kind && !source.kinds.includes(input.kind)) return [];
      try {
        const ctx = await contextFor(userId, source);
        return (await source.search(ctx, { q, kind: input.kind, limit: perSource }))
          .filter((item) => item && typeof item.id === "string" && item.id)
          .map((item) => ({ ...item, title: String(item.title || "Untitled").slice(0, 300) }));
      } catch (error) {
        if (input.source) throw error;
        errors.push({ source: source.id, message: error instanceof Error ? error.message : String(error) });
        return [];
      }
    }),
  );
  return { items: results.flat().slice(0, input.source ? limit : limit * 2), errors };
}

/**
 * Sources put ids into vendor URLs. Ids come from the vendor or from a link, but the
 * assistant can pass one too, so nothing that could leave the intended path or add a
 * query reaches a source.
 */
export function safeItemId(raw: string): string {
  const id = raw.trim();
  if (!id || id.length > 300 || /\.\.|[?&\\%\t\n\r]/.test(id)) throw new ItemError("That is not an item id this app uses.", 400);
  return id;
}

export async function readItem(userId: string, ref: { source: string; kind: AppItemKind; id: string }): Promise<AppItemContent> {
  const source = requireSource(ref.source);
  if (!source.kinds.includes(ref.kind) && ref.kind !== "person") throw new ItemError(`${source.label} has no ${ref.kind.replace("_", " ")} items here.`, 400);
  const ctx = await contextFor(userId, source);
  const content = await source.read(ctx, { kind: ref.kind, id: safeItemId(ref.id) });
  if (!content || typeof content.id !== "string") throw new ItemError(`${source.label} sent something Ensemble could not read.`);
  return { ...content, title: redact(String(content.title || "Untitled")).slice(0, 300), text: redact(String(content.text ?? "")).slice(0, MAX_ITEM_TEXT + 200) };
}

/** A file or email attachment's original bytes, through the person's own connection. */
export async function downloadItem(userId: string, ref: { source: string; kind: AppItemKind; id: string }, signal?: AbortSignal): Promise<ItemDownload> {
  const source = requireSource(ref.source);
  if (!source.download || !source.kinds.includes(ref.kind)) throw new ItemError(`Ensemble cannot bring ${ref.kind.replace("_", " ")} items from ${source.label} into Files.`, 400);
  const ctx = await contextFor(userId, source, signal ?? AbortSignal.timeout(180_000));
  const file = await source.download(ctx, { kind: ref.kind, id: safeItemId(ref.id) });
  if (!(file?.bytes instanceof Uint8Array)) throw new ItemError(`${source.label} sent something Ensemble could not read.`);
  if (file.bytes.byteLength > MAX_DOWNLOAD_BYTES) throw tooLarge(source.label);
  return {
    filename: String(file.filename || "file").slice(0, 500),
    mediaType: String(file.mediaType || "application/octet-stream").slice(0, 200),
    bytes: file.bytes,
    ...(file.url && /^https:\/\//i.test(file.url) ? { url: file.url.slice(0, 2000) } : {}),
  };
}

const ARTIFACT_KIND: Partial<Record<AppItemKind, ArtifactKind>> = {
  issue: "issue",
  ticket: "issue",
  work_item: "issue",
  card: "issue",
  task: "issue",
  pull_request: "pr",
  channel: "channel_msg",
  conversation: "chat_msg",
  meeting: "transcript",
  video: "transcript",
};

export const artifactKindFor = (kind: AppItemKind): ArtifactKind => ARTIFACT_KIND[kind] ?? "file";
export const artifactExternalId = (ref: { source: string; kind: AppItemKind; id: string }) => `app:${ref.source}:${ref.kind}:${ref.id}`.slice(0, 500);

interface AttachMeta {
  via: "app-item";
  source: string;
  itemKind: AppItemKind;
  itemId: string;
  subtitle?: string;
  facts?: Record<string, string>;
  attachedAt: string;
}

export function attachedView(row: { id: string; title: string; url: string | null; text: string; metadata: Prisma.JsonValue; taskId: string | null; projectId: string | null; createdAt: Date }): AttachedAppItem | null {
  const meta = (row.metadata ?? {}) as Partial<AttachMeta>;
  if (meta.via !== "app-item" || !meta.source || !meta.itemKind || !meta.itemId) return null;
  return {
    artifactId: row.id,
    source: meta.source,
    kind: meta.itemKind,
    id: meta.itemId,
    title: row.title,
    ...(meta.subtitle ? { subtitle: meta.subtitle } : {}),
    ...(row.url ? { url: row.url } : {}),
    attachedAt: meta.attachedAt ?? row.createdAt.toISOString(),
    chars: row.text.length,
    taskId: row.taskId,
    projectId: row.projectId,
  };
}

async function requireTarget(db: Db, userId: string, target: { taskId?: string | null; projectId?: string | null }) {
  if (target.taskId) {
    const task = await db.task.findFirst({ where: { id: target.taskId, userId, deletedAt: null }, select: { id: true, projectId: true } });
    if (!task) throw new ItemError("That task is not available.", 404);
  }
  if (target.projectId) {
    const project = await db.project.findFirst({ where: { id: target.projectId, userId, deletedAt: null }, select: { id: true } });
    if (!project) throw new ItemError("That project is not available.", 404);
  }
}

/** Saves an item's current text as context on a task and/or project. Attaching again refreshes it. */
export async function attachItem(
  userId: string,
  input: { source: string; kind: AppItemKind; id: string; taskId?: string | null; projectId?: string | null },
  db: Db = defaultPrisma,
): Promise<AttachedAppItem> {
  if (!input.taskId && !input.projectId) throw new ItemError("Choose a task or a project to attach it to.", 400);
  await requireTarget(db, userId, input);
  const content = await readItem(userId, input);
  return saveContent(db, userId, content, { taskId: input.taskId ?? null, projectId: input.projectId ?? null });
}

async function saveContent(db: Db, userId: string, content: AppItemContent, target: { taskId: string | null; projectId: string | null }): Promise<AttachedAppItem> {
  const kind = artifactKindFor(content.kind);
  const externalId = artifactExternalId(content);
  const existing = await db.artifact.findUnique({ where: { userId_kind_externalId: { userId, kind, externalId } }, select: { id: true, taskId: true, projectId: true, metadata: true } });
  const previous = (existing?.metadata ?? {}) as Partial<AttachMeta>;
  const metadata: AttachMeta = {
    via: "app-item",
    source: content.source,
    itemKind: content.kind,
    itemId: content.id,
    ...(content.subtitle ? { subtitle: content.subtitle.slice(0, 200) } : {}),
    ...(content.facts ? { facts: content.facts } : {}),
    attachedAt: previous.attachedAt ?? new Date().toISOString(),
  };
  const data = {
    url: content.url ?? null,
    ts: content.updatedAt ? new Date(content.updatedAt) : new Date(),
    title: content.title.slice(0, 500),
    text: content.text.slice(0, MAX_ITEM_TEXT + 200),
    participants: (content.people ?? []).slice(0, 50) as unknown as Prisma.InputJsonValue,
    metadata: metadata as unknown as Prisma.InputJsonValue,
    taskId: target.taskId ?? existing?.taskId ?? null,
    projectId: target.projectId ?? existing?.projectId ?? null,
    deletedAt: null,
  };
  if (Number.isNaN(data.ts.getTime())) data.ts = new Date();
  const row = existing
    ? await db.artifact.update({ where: { id: existing.id }, data })
    : await db.artifact.create({ data: { userId, kind, externalId, ...data } });
  return attachedView(row)!;
}

export async function attachedItems(userId: string, target: { taskId?: string; projectId?: string }, db: Db = defaultPrisma): Promise<AttachedAppItem[]> {
  const or: Prisma.ArtifactWhereInput[] = [];
  if (target.taskId) or.push({ taskId: target.taskId });
  if (target.projectId) or.push({ projectId: target.projectId });
  if (!or.length) return [];
  const rows = await db.artifact.findMany({
    where: { userId, deletedAt: null, OR: or, metadata: { path: ["via"], equals: "app-item" } },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, title: true, url: true, text: true, metadata: true, taskId: true, projectId: true, createdAt: true },
  });
  return rows.map(attachedView).filter((row): row is AttachedAppItem => Boolean(row));
}

async function attachedRow(db: Db, userId: string, artifactId: string) {
  const row = await db.artifact.findFirst({ where: { id: artifactId, userId, deletedAt: null } });
  const view = row ? attachedView(row) : null;
  if (!row || !view) throw new ItemError("That attachment is no longer available.", 404);
  return { row, view };
}

/** Reads the item again and keeps its links. */
export async function refreshAttached(userId: string, artifactId: string, db: Db = defaultPrisma): Promise<AttachedAppItem> {
  const { row, view } = await attachedRow(db, userId, artifactId);
  const content = await readItem(userId, { source: view.source, kind: view.kind, id: view.id });
  return saveContent(db, userId, content, { taskId: row.taskId, projectId: row.projectId });
}

/** Removes an attachment from a task or project; the stored text goes when nothing else uses it. */
export async function detachItem(userId: string, artifactId: string, from: { taskId?: string; projectId?: string }, db: Db = defaultPrisma): Promise<void> {
  const { row } = await attachedRow(db, userId, artifactId);
  const taskId = from.taskId && row.taskId === from.taskId ? null : row.taskId;
  const projectId = from.projectId && row.projectId === from.projectId ? null : row.projectId;
  const unlinkAll = !from.taskId && !from.projectId;
  await db.artifact.update({
    where: { id: row.id },
    data: unlinkAll || (!taskId && !projectId) ? { taskId: null, projectId: null, deletedAt: new Date() } : { taskId, projectId },
  });
}

const TASK_SOURCE: Record<string, TaskSource> = {
  github: "github",
  linear: "linear",
  atlassian: "jira",
  jira: "jira",
  trello: "trello",
  asana: "asana",
  todoist: "todoist",
  clickup: "clickup",
  monday: "monday",
  notion: "notion",
  slack: "slack",
};

/** Turns an issue, card or ticket into an Ensemble task, with the item attached as its context. Adding it again updates the same task. */
export async function taskFromItem(
  userId: string,
  input: { source: string; kind: AppItemKind; id: string; projectId?: string | null },
  db: Db = defaultPrisma,
): Promise<{ taskId: string; created: boolean }> {
  if (!TASK_LIKE_KINDS.has(input.kind) && input.kind !== "page") throw new ItemError("Only issues, cards, tickets and pages become tasks.", 400);
  await requireTarget(db, userId, { projectId: input.projectId });
  const content = await readItem(userId, input);
  const externalSource = `app:${content.source}`;
  const externalId = `${content.kind}:${content.id}`.slice(0, 300);
  const existing = await db.task.findUnique({ where: { userId_externalSource_externalId: { userId, externalSource, externalId } }, select: { id: true, deletedAt: true } });
  const due = content.facts?.Due && /^\d{4}-\d{2}-\d{2}/.test(content.facts.Due) ? new Date(`${content.facts.Due.slice(0, 10)}T00:00:00.000Z`) : null;
  const data = {
    title: content.title.slice(0, 300),
    sourceKind: TASK_SOURCE[content.source] ?? ("other" as TaskSource),
    sourceRef: `${content.source}:${content.kind}:${content.id}`.slice(0, 300),
    sourceUrl: content.url ?? null,
    excerpt: content.text.replace(/^# .*\n+/, "").slice(0, 280) || null,
    ...(due ? { due } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
  };
  const task = existing
    ? await db.task.update({ where: { id: existing.id }, data: { ...data, deletedAt: null } })
    : await db.task.create({
        data: {
          userId,
          ...data,
          externalSource,
          externalId,
          status: "todo",
          owner: "me",
          createdBy: "me",
          rationale: `Added from ${content.source}`,
        },
      });
  await saveContent(db, userId, content, { taskId: task.id, projectId: input.projectId ?? null });
  return { taskId: task.id, created: !existing };
}

const IDENTITY_KIND: Record<string, "slack" | "github" | "linear" | "jira" | "teams" | null> = {
  slack: "slack",
  github: "github",
  linear: "linear",
  atlassian: "jira",
  microsoft: "teams",
};

/** Adds the app's people to Ensemble's People, matched by email or handle. Never merges two existing people. */
export async function importPeople(userId: string, sourceId: string, db: Db = defaultPrisma): Promise<{ seen: number; added: number; matched: number; skipped: number }> {
  const source = requireSource(sourceId);
  if (!source.people) throw new ItemError(`${source.label} has no people list Ensemble can read.`, 400);
  const ctx = await contextFor(userId, source);
  const people = (await source.people(ctx)).slice(0, MAX_PEOPLE);
  const self = [ctx.token.account, ctx.token.account?.split(" @ ")[0]];
  const before = await db.person.count({ where: { userId } });
  const kind = IDENTITY_KIND[source.id];
  let matched = 0;
  let skipped = 0;
  const at = new Date();
  for (const person of people) {
    const handle = person.handle && kind ? `${kind}:${person.handle}` : null;
    if (!person.email && !handle) {
      skipped += 1;
      continue;
    }
    const id = await upsertPerson(userId, { email: person.email ?? null, name: person.name, handle, at, evidence: `${source.id}:people` }, self);
    if (id) matched += 1;
    else skipped += 1;
  }
  const added = Math.max(0, (await db.person.count({ where: { userId } })) - before);
  await appendLedger({ userId, actor: "me", action: "people.import", payload: { source: source.id, seen: people.length, added } });
  return { seen: people.length, added, matched: Math.max(0, matched - added), skipped };
}

/** Where to post an update for a task: an attached comment-capable item, else the task's own source link. */
export async function updateTargetFor(userId: string, taskId: string, db: Db = defaultPrisma): Promise<{ source: string; kind: AppItemKind; id: string; title: string; url?: string } | null> {
  const task = await db.task.findFirst({ where: { id: taskId, userId, deletedAt: null }, select: { sourceUrl: true, title: true } });
  if (!task) throw new ItemError("That task is not available.", 404);
  const attached = await attachedItems(userId, { taskId }, db);
  for (const item of attached) {
    const source = itemSource(item.source);
    if (source?.comment && TASK_LIKE_KINDS.has(item.kind)) return { source: item.source, kind: item.kind, id: item.id, title: item.title, ...(item.url ? { url: item.url } : {}) };
  }
  if (task.sourceUrl) {
    const connected = new Set((await connectedItemSources(userId, db)).map((row) => row.id));
    for (const source of ITEM_SOURCES) {
      if (!source.comment || !source.fromUrl || !connected.has(source.id)) continue;
      const ref = source.fromUrl(task.sourceUrl);
      if (ref) return { source: source.id, ...ref, title: task.title, url: task.sourceUrl };
    }
  }
  return null;
}

/** Posts the person's text as a comment on the task's linked issue. Only called from an explicit Post. */
export async function postUpdate(userId: string, taskId: string, body: string, db: Db = defaultPrisma): Promise<{ source: string; url?: string }> {
  const text = body.trim();
  if (!text) throw new ItemError("Write the update first.", 400);
  const target = await updateTargetFor(userId, taskId, db);
  if (!target) throw new ItemError("This task is not linked to an issue Ensemble can comment on.", 409);
  const source = requireSource(target.source);
  const ctx = await contextFor(userId, source);
  const result = await source.comment!(ctx, { kind: target.kind, id: safeItemId(target.id) }, text.slice(0, 20_000));
  await appendLedger({ userId, actor: "me", action: "apps.post_update", payload: { source: target.source, kind: target.kind, item: target.id, taskId, chars: text.length } });
  return { source: target.source, ...(result.url ? { url: result.url } : {}) };
}

/** Attached text for prompts (agents, the assistant): newest first, capped in total. */
export async function contextForPrompt(userId: string, target: { taskId?: string | null; projectId?: string | null }, maxChars = 12_000, db: Db = defaultPrisma): Promise<string> {
  const or: Prisma.ArtifactWhereInput[] = [];
  if (target.taskId) or.push({ taskId: target.taskId });
  if (target.projectId) or.push({ projectId: target.projectId });
  if (!or.length) return "";
  const rows = await db.artifact.findMany({
    where: { userId, deletedAt: null, OR: or, metadata: { path: ["via"], equals: "app-item" } },
    orderBy: [{ taskId: "asc" }, { createdAt: "desc" }],
    take: 12,
    select: { title: true, url: true, text: true, metadata: true },
  });
  let left = maxChars;
  const parts: string[] = [];
  for (const row of rows) {
    if (left <= 200) break;
    const meta = row.metadata as Partial<AttachMeta>;
    const head = `### ${row.title} (${meta.source ?? "app"} ${meta.itemKind ?? "item"})${row.url ? `\n${row.url}` : ""}`;
    const body = row.text.slice(0, Math.max(0, left - head.length - 10));
    parts.push(`${head}\n${body}`);
    left -= head.length + body.length + 2;
  }
  return parts.join("\n\n");
}
