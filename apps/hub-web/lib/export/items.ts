import type { PageRecord, MeetingSessionRecord, SkillRecord, StandalonePageRecord, TaskRecord } from "../api";
import { PRIORITY, STATUS } from "../format";
import { blocksFromMarkdown, blocksFromPage, type Block, type ExportDoc } from "./document";

function bodyBlocks(content: unknown, notes: string): Block[] {
  const fromPage = content ? blocksFromPage(content) : [];
  if (fromPage.length) return fromPage;
  return notes.trim() ? blocksFromMarkdown(notes) : [];
}

export function pageDoc(page: Pick<StandalonePageRecord, "title" | "content" | "notes" | "updatedAt">): ExportDoc {
  return {
    title: page.title || "Untitled",
    meta: page.updatedAt ? [["Updated", new Date(page.updatedAt).toLocaleString()]] : undefined,
    blocks: bodyBlocks(page.content, page.notes),
  };
}

export function taskDoc(task: TaskRecord, page: PageRecord | null | undefined, ownerText: string): ExportDoc {
  const meta: Array<[string, string]> = [
    ["Status", STATUS[task.status]?.label ?? task.status],
    ["Priority", PRIORITY[task.priority]?.label ?? task.priority],
    ["Owner", ownerText],
  ];
  if (task.due) meta.push(["Due", new Date(task.due).toLocaleDateString()]);
  if (task.labels?.length) meta.push(["Labels", task.labels.join(", ")]);
  if (task.sourceUrl) meta.push(["Source", task.sourceUrl]);
  const blocks: Block[] = [];
  if (task.description.trim()) blocks.push(...blocksFromMarkdown(task.description));
  blocks.push(...bodyBlocks(page?.content, page?.notes ?? task.notes ?? ""));
  return { title: task.title || "Untitled task", meta, blocks };
}

export function meetingDoc(session: MeetingSessionRecord, people: string[] = []): ExportDoc {
  const meta: Array<[string, string]> = [["Started", new Date(session.startedAt).toLocaleString()]];
  if (session.endedAt) meta.push(["Ended", new Date(session.endedAt).toLocaleString()]);
  if (people.length) meta.push(["People", people.join(", ")]);
  const blocks: Block[] = [];
  if (session.recap.trim()) blocks.push({ type: "heading", level: 1, runs: [{ text: "Recap" }] }, ...blocksFromMarkdown(session.recap));
  if (session.notes.trim()) blocks.push({ type: "heading", level: 1, runs: [{ text: "Notes" }] }, ...blocksFromMarkdown(session.notes));
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
