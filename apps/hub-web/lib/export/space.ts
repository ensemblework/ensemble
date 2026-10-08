"use client";

/**
 * Download a whole Ensemble space as one ZIP, built in the browser from the same GET routes the
 * Hub already uses. The server only serves reads; zipping, Markdown, CSV and diagram images all
 * happen on the person's machine.
 */

import { parseDiagram } from "@ensemble/block-diagrams";

import { api, type TaskRecord } from "../api";
import { OWNER_LABEL, PRIORITY, STATUS } from "../format";
import { toMarkdown } from "./document";
import { fileSlug } from "./formats";
import { meetingDoc, pageDoc, skillDoc, taskDoc } from "./items";

export type SpaceSection = "pages" | "tasks" | "context" | "meetings" | "skills" | "diagrams" | "plots";

export type ExportProgress = { section: SpaceSection | "zip"; done: number; total: number; label: string };

type Files = Record<string, Uint8Array>;

const encoder = new TextEncoder();

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : Array.isArray(value) ? value.join("; ") : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** Runs `work` over `items`, a few at a time, so a big space does not flood the API. */
async function eachLimited<T>(items: T[], limit: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await work(items[index]!, index);
    }
  });
  await Promise.all(lanes);
}

function uniqueName(used: Set<string>, folder: string, title: string, ext: string): string {
  const base = fileSlug(title);
  let name = `${folder}/${base}.${ext}`;
  for (let count = 2; used.has(name); count += 1) name = `${folder}/${base}-${count}.${ext}`;
  used.add(name);
  return name;
}

function collectDatasetIds(value: unknown, into: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectDatasetIds(item, into);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if ((key === "datasetId" || key === "dataset") && typeof child === "string" && child) into.add(child);
    else collectDatasetIds(child, into);
  }
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export async function exportSpace(options: {
  spaceName: string;
  /** Names of the space's owner and members, to say who a task is with. */
  people?: { ownerId: string | null; names: Map<string, string> };
  sections: SpaceSection[];
  onProgress?: (progress: ExportProgress) => void;
}): Promise<{ blob: Blob; name: string; skipped: string[] }> {
  const files: Files = {};
  const used = new Set<string>();
  const skipped: string[] = [];
  const counts: string[] = [];
  const put = (path: string, content: string | Uint8Array) => {
    files[path] = typeof content === "string" ? encoder.encode(content) : content;
  };
  const report = (section: SpaceSection | "zip", done: number, total: number, label: string) => options.onProgress?.({ section, done, total, label });
  const want = new Set(options.sections);

  if (want.has("pages")) {
    report("pages", 0, 1, "Reading pages");
    const { pages } = await api.pages();
    await eachLimited(pages, 5, async (summary, index) => {
      try {
        const page = await api.standalonePage(summary.id);
        put(uniqueName(used, "pages", page.title || "untitled", "md"), toMarkdown(pageDoc(page)));
      } catch {
        skipped.push(`Page "${summary.title}"`);
      }
      report("pages", index + 1, pages.length, "Pages");
    });
    counts.push(plural(pages.length, "page"));
  }

  if (want.has("tasks")) {
    report("tasks", 0, 1, "Reading tasks");
    const { tasks } = await api.tasks();
    const ownerText = (task: TaskRecord) => {
      if (task.owner !== "me") return OWNER_LABEL[task.owner] ?? task.owner;
      const id = task.assigneeAccountId ?? options.people?.ownerId;
      return (id && options.people?.names.get(id)) || "Me";
    };
    await eachLimited(tasks, 5, async (task, index) => {
      const page = await api.page(task.id).catch(() => null);
      put(uniqueName(used, `tasks/${task.status}`, task.title || "untitled", "md"), toMarkdown(taskDoc(task, page, ownerText(task))));
      report("tasks", index + 1, tasks.length, "Tasks");
    });
    put(
      "tasks/tasks.csv",
      toCsv(
        ["id", "title", "status", "priority", "owner", "due", "labels", "source", "created", "completed"],
        tasks.map((task) => [
          task.id,
          task.title,
          STATUS[task.status]?.label ?? task.status,
          PRIORITY[task.priority]?.label ?? task.priority,
          ownerText(task),
          task.due,
          task.labels ?? [],
          task.sourceUrl,
          task.createdAt,
          task.completedAt,
        ]),
      ),
    );
    put("tasks/tasks.json", JSON.stringify(tasks, null, 2));
    counts.push(plural(tasks.length, "task"));
  }

  if (want.has("context")) {
    report("context", 0, 4, "Reading context");
    const [people, projects, repos, deliverables] = await Promise.all([
      api.people().catch(() => null),
      api.projects().catch(() => null),
      api.repos().catch(() => null),
      api.deliverables(true).catch(() => null),
    ]);
    if (people) {
      put("context/people.csv", toCsv(["name", "email", "role", "team", "last interaction", "projects"], people.people.map((row) => [row.name, row.email, row.role, row.team, row.lastInteraction, row.projects.map((p) => p.name)])));
      put("context/people.json", JSON.stringify(people.people, null, 2));
    } else skipped.push("People");
    if (projects) {
      put("context/projects.csv", toCsv(["name", "status", "summary", "repos", "people"], projects.projects.map((row) => [row.name, row.status, row.summary, row.repos.map((r) => r.fullName), row.people.map((p) => p.name)])));
      put("context/projects.json", JSON.stringify(projects.projects, null, 2));
    } else skipped.push("Projects");
    if (repos) {
      put("context/repos.csv", toCsv(["repository", "provider", "url", "default branch", "languages", "projects"], repos.repos.map((row) => [row.fullName, row.provider, row.url, row.defaultBranch, row.languages, row.projects.map((p) => p.name)])));
      put("context/repos.json", JSON.stringify(repos.repos, null, 2));
    } else skipped.push("Repos");
    if (deliverables) {
      put("context/deliverables.csv", toCsv(["title", "status", "due", "project"], deliverables.deliverables.map((row) => [row.title, row.status, row.due, row.project.name])));
      put("context/deliverables.json", JSON.stringify(deliverables.deliverables, null, 2));
    } else skipped.push("Deliverables");
    report("context", 4, 4, "Context");
    counts.push(`${plural(people?.people.length ?? 0, "person").replace(/persons$/, "people")}, ${plural(projects?.projects.length ?? 0, "project")}`);
  }

  if (want.has("meetings")) {
    report("meetings", 0, 1, "Reading meeting notes");
    const [sessions, imported] = await Promise.all([api.meetingSessions().catch(() => null), api.importedMeetings().catch(() => null)]);
    for (const session of sessions?.sessions ?? []) put(uniqueName(used, "meetings", session.title || "meeting", "md"), toMarkdown(meetingDoc(session)));
    for (const note of imported?.notes ?? []) {
      const markdown = [
        `# ${note.title}`,
        "",
        `- **When:** ${new Date(note.occurredAt).toLocaleString()}`,
        `- **From:** ${note.sourceLabel}`,
        ...(note.people.length ? [`- **People:** ${note.people.map((person) => person.name).join(", ")}`] : []),
        "",
        note.summary,
        ...(note.decisions.length ? ["", "## Decisions", ...note.decisions.map((item) => `- ${item}`)] : []),
        ...(note.actionItems.length ? ["", "## Action items", ...note.actionItems.map((item) => `- [${item.completed ? "x" : " "}] ${item.text}${item.owner?.name ? ` (${item.owner.name})` : ""}`)] : []),
        "",
      ].join("\n");
      put(uniqueName(used, "meetings/imported", note.title || "meeting", "md"), markdown);
    }
    if (!sessions && !imported) skipped.push("Meeting notes");
    report("meetings", 1, 1, "Meeting notes");
    counts.push(plural((sessions?.sessions.length ?? 0) + (imported?.notes.length ?? 0), "meeting note"));
  }

  if (want.has("skills")) {
    report("skills", 0, 1, "Reading skills");
    const skills = await api.skills().catch(() => null);
    for (const skill of skills?.skills ?? []) put(uniqueName(used, "skills", skill.slug || skill.name, "md"), toMarkdown(skillDoc(skill)));
    if (!skills) skipped.push("Skills");
    report("skills", 1, 1, "Skills");
    counts.push(plural(skills?.skills.length ?? 0, "skill"));
  }

  if (want.has("diagrams")) {
    report("diagrams", 0, 1, "Reading diagrams");
    const list = await api.diagrams().catch(() => null);
    if (!list) skipped.push("Diagrams (turned off in this space)");
    const { diagramFiles } = await import("@/components/diagrams/export-image");
    const rows = list?.diagrams ?? [];
    await eachLimited(rows, 3, async (summary, index) => {
      try {
        const { diagram } = await api.diagram(summary.id);
        const name = uniqueName(used, "diagrams", diagram.title || summary.title || "diagram", "txt").replace(/\.txt$/, "");
        put(`${name}.txt`, diagram.source);
        const images = await diagramFiles(parseDiagram(diagram.source).model);
        put(`${name}.svg`, images.svg);
        if (images.png) put(`${name}.png`, new Uint8Array(await images.png.arrayBuffer()));
      } catch {
        skipped.push(`Diagram "${summary.title}"`);
      }
      report("diagrams", index + 1, rows.length, "Diagrams");
    });
    counts.push(plural(rows.length, "diagram"));
  }

  if (want.has("plots")) {
    report("plots", 0, 1, "Reading plots");
    const list = await api.plots().catch(() => null);
    if (!list) skipped.push("Plots (turned off in this space)");
    const datasets = new Set<string>();
    for (const plot of list?.plots ?? []) {
      if (plot.datasetId) datasets.add(plot.datasetId);
      collectDatasetIds(plot.config, datasets);
      put(uniqueName(used, "plots", plot.title || "plot", "json"), JSON.stringify({ title: plot.title, dataset: plot.datasetName, updatedAt: plot.updatedAt, config: plot.config }, null, 2));
    }
    const ids = [...datasets];
    await eachLimited(ids, 3, async (id, index) => {
      try {
        const { dataset } = await api.plotDataset(id, true);
        put(uniqueName(used, "plots/data", dataset.name.replace(/\.[a-z0-9]+$/i, "") || "data", "csv"), toCsv(dataset.columns.map((column) => column.name), dataset.rows));
      } catch {
        // A tile can point at data that was deleted since; nothing to export for it.
      }
      report("plots", index + 1, ids.length, "Plot data");
    });
    counts.push(`${plural(list?.plots.length ?? 0, "plot space")}, ${plural(ids.length, "data file")}`);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  put(
    "README.md",
    [
      `# ${options.spaceName}`,
      "",
      `Exported from Ensemble on ${new Date().toLocaleString()}.`,
      "",
      ...counts.map((line) => `- ${line}`),
      "",
      "Markdown files open in any editor, Obsidian or Notion (Import › Markdown). CSV files open in Excel, Numbers or Google Sheets.",
      "To get a plot as a PDF figure, open it in Plots and use Export figure.",
      ...(skipped.length ? ["", "## Not included", "", ...skipped.map((line) => `- ${line}`)] : []),
      "",
    ].join("\n"),
  );

  report("zip", 0, 1, "Packing the ZIP");
  const { zip } = await import("fflate");
  const data = await new Promise<Uint8Array>((resolve, reject) => zip(files, { level: 6 }, (error, output) => (error ? reject(error) : resolve(output))));
  report("zip", 1, 1, "Done");
  return { blob: new Blob([data as BlobPart], { type: "application/zip" }), name: `${fileSlug(options.spaceName)}-${stamp}.zip`, skipped };
}
