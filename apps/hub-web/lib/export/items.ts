import type { PageRecord, MeetingSessionRecord, SkillRecord, StandalonePageRecord, TaskRecord } from "../api";
import { PRIORITY, STATUS } from "../format";
import { blocksFromMarkdown, blocksFromPage, type Block, type ExportDoc } from "./document";

function bodyBlocks(content: unknown, notes: string): Block[] {
  const fromPage = content ? blocksFromPage(content) : [];
  if (fromPage.length) return fromPage;
  return notes.trim() ? blocksFromMarkdown(notes) : [];
}

/** How a document writes a time. One file on its own reads local time; a whole-space download passes ISO 8601 with an offset. */
export type WriteTime = (value: string, kind: "moment" | "date") => string;

const localTime: WriteTime = (value, kind) => (kind === "date" ? new Date(value).toLocaleDateString() : new Date(value).toLocaleString());

export function pageDoc(page: Pick<StandalonePageRecord, "title" | "content" | "notes" | "updatedAt">, when: WriteTime = localTime): ExportDoc {
  return {
    title: page.title || "Untitled",
    meta: page.updatedAt ? [["Updated", when(page.updatedAt, "moment")]] : undefined,
    blocks: bodyBlocks(page.content, page.notes),
  };
}

export function taskDoc(task: TaskRecord, page: PageRecord | null | undefined, ownerText: string, when: WriteTime = localTime): ExportDoc {
  const meta: Array<[string, string]> = [
    ["Status", STATUS[task.status]?.label ?? task.status],
    ["Priority", PRIORITY[task.priority]?.label ?? task.priority],
    ["Owner", ownerText],
  ];
  if (task.due) meta.push(["Due", when(task.due, "date")]);
  if (task.labels?.length) meta.push(["Labels", task.labels.join(", ")]);
  if (task.sourceUrl) meta.push(["Source", task.sourceUrl]);
  const blocks: Block[] = [];
  if (task.description.trim()) blocks.push(...blocksFromMarkdown(task.description));
  blocks.push(...bodyBlocks(page?.content, page?.notes ?? task.notes ?? ""));
  return { title: task.title || "Untitled task", meta, blocks };
}

export function meetingDoc(session: MeetingSessionRecord, people: string[] = [], when: WriteTime = localTime): ExportDoc {
  const meta: Array<[string, string]> = [["Started", when(session.startedAt, "moment")]];
  if (session.endedAt) meta.push(["Ended", when(session.endedAt, "moment")]);
  if (people.length) meta.push(["People", people.join(", ")]);
  const blocks: Block[] = [];
  if (session.recap.trim()) blocks.push({ type: "heading", level: 1, runs: [{ text: "Recap" }] }, ...blocksFromMarkdown(session.recap));
  const notes = bodyBlocks(session.content, session.notes);
  if (notes.length) blocks.push({ type: "heading", level: 1, runs: [{ text: "Notes" }] }, ...notes);
  return { title: session.title || "Meeting notes", meta, blocks };
}

export function skillDoc(skill: Pick<SkillRecord, "name" | "description" | "version" | "body" | "enabled">): ExportDoc {
  return {
    title: skill.name,
    meta: [
      ["Version", `v${skill.version}`],
      ["Status", skill.enabled ? "On" : "Off"],
      ...(skill.description ? ([["Description", skill.description]] as Array<[string, string]>) : []),
    ],
    blocks: blocksFromMarkdown(skill.body),
  };
}
