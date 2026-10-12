/**
 * Figma: a design file by its link, or files and projects by name in the team saved
 * at connect; a file's pages and top-level frames with its latest comments; file comments.
 * Ids: the file key for a design, the numeric project id for a project.
 */
import type { AppItem, AppItemContent, AppItemPerson } from "@ensemble/shared-types";
import { facts, itemFetch, itemMarkdown } from "../http.js";
import { ItemError, type ItemContext, type ItemSource } from "../types.js";

const API = "https://api.figma.com/v1";
const LABEL = "Figma";
/** Project file lists are fetched one by one; Figma rate limits them per minute. */
const MAX_PROJECTS = 10;
const MAX_FRAMES_PER_PAGE = 60;

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
}

interface FigmaFile {
  name: string;
  lastModified?: string;
  editorType?: string;
  document?: FigmaNode;
}

interface ProjectFile {
  key: string;
  name: string;
  last_modified?: string;
}

interface FigmaComment {
  id: string;
  message?: string;
  created_at?: string;
  resolved_at?: string | null;
  user?: { handle?: string };
}

const KEY = /^[A-Za-z0-9]{10,64}$/;
const NUMERIC = /^\d{1,25}$/;

const headers = (ctx: ItemContext) => ({ "X-Figma-Token": ctx.token.token });

const get = <T>(ctx: ItemContext, path: string) => itemFetch<T>(ctx, "figma", LABEL, `${API}${path}`, { headers: headers(ctx) });

/** "https://www.figma.com/design/<key>/Name?node-id=…" (or /file/, /board/, /proto/, /slides/) → the file key. */
export function figmaFileKey(text: string): string | null {
  const match = /figma\.com\/(?:file|design|board|proto|slides)\/([A-Za-z0-9]{10,64})/i.exec(text.trim());
  return match ? match[1]! : null;
}

const fileUrl = (key: string, editorType?: string) => `https://www.figma.com/${editorType === "figjam" ? "board" : "design"}/${key}`;

function designItem(key: string, name: string, subtitle: string, updatedAt?: string, editorType?: string): AppItem {
  return { source: "figma", kind: "design", id: key, title: name || "Untitled", subtitle, url: fileUrl(key, editorType), updatedAt };
}

const projectItem = (id: string, name: string): AppItem => ({
  source: "figma",
  kind: "project",
  id,
  title: name || "Untitled project",
  subtitle: "Project",
  url: `https://www.figma.com/files/project/${id}`,
});

function savedTeam(ctx: ItemContext): string | null {
  const id = ctx.token.meta?.teamId;
  return typeof id === "string" && NUMERIC.test(id) ? id : null;
}

const byNewest = (a: AppItem, b: AppItem) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");

export const figmaItems: ItemSource = {
  id: "figma",
  provider: "figma",
  label: LABEL,
  kinds: ["design", "project"],
  async search(ctx, query) {
    const key = figmaFileKey(query.q);
    if (key) {
      if (query.kind === "project") return [];
      const file = await get<FigmaFile>(ctx, `/files/${key}?depth=1`);
      return [designItem(key, file.name, file.editorType === "figjam" ? "FigJam board" : "Design file", file.lastModified, file.editorType)];
    }
    const team = savedTeam(ctx);
    if (!team) {
      if (!query.q.trim()) return [];
      throw new ItemError("Paste a Figma file link to find it, or connect Figma again with your team link to search by name.", 400);
    }
    const needle = query.q.trim().toLowerCase();
    const { projects } = await get<{ projects: Array<{ id: string | number; name: string }> }>(ctx, `/teams/${team}/projects`);
    const designs: AppItem[] = [];
    if (!query.kind || query.kind === "design") {
      for (const project of projects.slice(0, MAX_PROJECTS)) {
        const listed = await get<{ files: ProjectFile[] }>(ctx, `/projects/${project.id}/files`);
        for (const file of listed.files) {
          if (!needle || file.name.toLowerCase().includes(needle)) designs.push(designItem(file.key, file.name, project.name, file.last_modified));
        }
        if (needle && designs.length >= query.limit) break;
      }
    }
    const matching = !query.kind || query.kind === "project" ? projects.filter((project) => !needle || project.name.toLowerCase().includes(needle)) : [];
    const projectItems = matching.map((project) => projectItem(String(project.id), project.name));
    if (query.kind === "project") return projectItems.slice(0, query.limit);
    return [...designs.sort(byNewest).slice(0, query.limit), ...projectItems.slice(0, 3)];
  },
  async read(ctx, ref): Promise<AppItemContent> {
    if (ref.kind === "project") {
      if (!NUMERIC.test(ref.id)) throw new ItemError("That is not a Figma project id.", 400);
      const listed = await get<{ name?: string; files: ProjectFile[] }>(ctx, `/projects/${ref.id}/files`);
      const files = listed.files.map((file) => designItem(file.key, file.name, listed.name ?? "", file.last_modified)).sort(byNewest);
      const item = projectItem(ref.id, listed.name ?? "");
      const list = facts({ Files: files.length });
      const lines = files.map((file) => `- [${file.title}](${file.url})${file.updatedAt ? ` (updated ${file.updatedAt.slice(0, 10)})` : ""}`);
      return { ...item, updatedAt: files[0]?.updatedAt, facts: list, text: itemMarkdown(item.title, list, lines.length ? `## Files\n\n${lines.join("\n")}` : "") };
    }
    if (!KEY.test(ref.id)) throw new ItemError("That is not a Figma file key.", 400);
    const file = await get<FigmaFile>(ctx, `/files/${ref.id}?depth=2`);
    const comments = await get<{ comments: FigmaComment[] }>(ctx, `/files/${ref.id}/comments`).catch(() => ({ comments: [] as FigmaComment[] }));
    const pages = file.document?.children ?? [];
    const outline = pages.map((page) => {
      const nodes = page.children ?? [];
      const lines = nodes.slice(0, MAX_FRAMES_PER_PAGE).map((node) => `- ${node.name} (${node.type.toLowerCase().replace(/_/g, " ")})`);
      if (nodes.length > MAX_FRAMES_PER_PAGE) lines.push(`- … ${nodes.length - MAX_FRAMES_PER_PAGE} more`);
      return `## ${page.name}\n\n${lines.join("\n") || "(empty page)"}`;
    });
    const latest = [...comments.comments]
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
      .slice(0, 20)
      .reverse();
    const thread = latest
      .map((comment) => `**${comment.user?.handle ?? "Someone"}** (${(comment.created_at ?? "").slice(0, 10)}${comment.resolved_at ? ", resolved" : ""}):\n${comment.message ?? ""}`)
      .join("\n\n");
    const people: AppItemPerson[] = [...new Set(latest.map((comment) => comment.user?.handle).filter((handle): handle is string => Boolean(handle)))].map((handle) => ({ name: handle, handle }));
    const kind = file.editorType === "figjam" ? "FigJam board" : "Design file";
    const list = facts({ Type: kind, Pages: pages.length, "Last modified": file.lastModified?.slice(0, 10), Comments: comments.comments.length || null });
    return {
      ...designItem(ref.id, file.name, kind, file.lastModified, file.editorType),
      facts: list,
      people,
      text: itemMarkdown(file.name || "Untitled", list, [outline.join("\n\n"), thread ? `## Latest comments\n\n${thread}` : ""].filter(Boolean).join("\n\n")),
    };
  },
  fromUrl(url) {
    const key = figmaFileKey(url);
    return key ? { kind: "design", id: key } : null;
  },
  async comment(ctx, ref, body) {
    if (ref.kind !== "design" || !KEY.test(ref.id)) throw new ItemError("Only Figma files take comments.", 400);
    await itemFetch(ctx, "figma", LABEL, `${API}/files/${ref.id}/comments`, { method: "POST", headers: headers(ctx), body: { message: body } });
    return { url: fileUrl(ref.id) };
  },
};
