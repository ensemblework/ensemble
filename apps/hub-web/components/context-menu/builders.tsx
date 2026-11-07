"use client";

/**
 * The menus several places share: the page-wide one (where nothing nearer has a menu), a task's
 * (board cards, the task page, sidebar rows) and a page's (sidebar rows, the page itself), and the
 * Ask Ensemble items any picked text or block gets.
 */
import type { QueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Columns3,
  Copy,
  CopyPlus,
  Download,
  ExternalLink,
  FileText,
  Flag,
  Link2,
  ListTodo,
  MessageSquarePlus,
  PanelRight,
  Paperclip,
  Pencil,
  RotateCw,
  Search,
  Settings,
  Sparkles,
  Trash2,
  UserRound,
} from "lucide-react";
import { DOC_FORMATS, downloadDocument } from "@/lib/export/formats";
import { pageDoc } from "@/lib/export/items";
import { api, type TaskRecord } from "@/lib/api";
import { ASK_PRESETS, attachToAssistant, type AssistantAttachment } from "@/lib/assistant-attach";
import { NO_NODES } from "@/lib/node-owner";
import { PRIORITY, PRIORITY_ORDER, STATUS } from "@/lib/format";
import { Calendar, dayKey } from "../date-time";
import { rememberPick, withRecent, type MenuAction, type MenuSection, type MenuSpec } from "./menu-store";

const short = (text: string, max = 28) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

export const absolute = (href: string) => new URL(href, window.location.origin).toString();

export function openPalette(query?: string): void {
  window.dispatchEvent(new CustomEvent("ensemble:palette", { detail: { query } }));
}

/** "Ask Ensemble ▸" and "Attach to assistant" for picked text, a block or a whole record. */
export function askItems(attachment: AssistantAttachment, extra: Array<{ id: string; label: string; prompt: string }> = []): MenuAction[] {
  return [
    {
      id: "ask",
      label: "Ask Ensemble",
      icon: Sparkles,
      submenu: () => ({
        sections: [
          { items: [...extra, ...ASK_PRESETS].map((preset) => ({ id: `ask-${preset.id}`, label: preset.label, run: () => attachToAssistant({ attachment, prompt: preset.prompt, send: true }) })) },
          { items: [{ id: "ask-own", label: "Ask something else…", icon: MessageSquarePlus, run: () => attachToAssistant({ attachment }) }] },
        ],
      }),
    },
    { id: "attach", label: "Attach to assistant", icon: Paperclip, run: () => attachToAssistant({ attachment }) },
  ];
}

type Nav = { navigate: (href: string) => void; back: () => void; forward: () => void; refresh: () => void };

/** The name of the screen, for "Attach to assistant" from it. */
function viewTitle(): string {
  const heading = document.querySelector<HTMLElement>("#main-content h1")?.innerText?.trim();
  return heading || document.title.replace(/\s*[·|—-]\s*Ensemble.*$/i, "").trim() || "this screen";
}

/** Where nothing nearer has a menu: picked text, a link, an image, or the screen itself. */
export function pageWideMenu(event: MouseEvent, nav: Nav): MenuSpec | null {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return null;
  // Surfaces that use the right button themselves, and media, keep the browser's menu.
  if (target.closest("canvas, video, audio, iframe, .react-flow, [data-cm-off]")) return null;
  const link = target.closest<HTMLAnchorElement>("a[href]");
  const image = target.closest("img");
  const picked = window.getSelection()?.toString().trim() ?? "";
  const here: AssistantAttachment["source"] = { kind: "view", id: window.location.pathname, title: viewTitle() };
  const sections: MenuSection[] = [];
  if (picked) {
    sections.push({
      items: [
        { id: "copy", label: "Copy", icon: Copy, hint: "Ctrl+C", run: () => copyText(picked) },
        { id: "search", label: `Search for “${short(picked, 22)}”`, icon: Search, run: () => openPalette(picked) },
      ],
    });
    sections.push({ items: askItems({ text: picked, source: here }) });
  }
  if (link) {
    const href = link.getAttribute("href") ?? "";
    const inside = href.startsWith("/") || link.origin === window.location.origin;
    sections.push({
      items: [
        { id: "link-open", label: "Open link", icon: ArrowUpRight, run: () => (inside ? nav.navigate(link.pathname + link.search + link.hash) : window.open(link.href, "_blank", "noopener")) },
        { id: "link-tab", label: "Open in new tab", icon: ExternalLink, run: () => window.open(link.href, "_blank", "noopener") },
        { id: "link-copy", label: "Copy link address", icon: Link2, run: () => copyText(link.href) },
      ],
    });
  } else if (image instanceof HTMLImageElement && image.src) {
    sections.push({
      items: [
        { id: "image-open", label: "Open image in new tab", icon: ExternalLink, run: () => window.open(image.src, "_blank", "noopener") },
        { id: "image-copy", label: "Copy image address", icon: Link2, run: () => copyText(image.src) },
      ],
    });
  }
  if (!picked && !link && !image) {
    sections.push({
      items: [
        {
          id: "nav",
          row: [
            { id: "back", label: "Back", icon: ArrowLeft, run: nav.back, disabled: window.history.length <= 1 },
            { id: "forward", label: "Forward", icon: ArrowRight, run: nav.forward },
            { id: "reload", label: "Reload", icon: RotateCw, run: () => window.location.reload() },
          ],
        },
      ],
    });
    sections.push({
      items: [
        { id: "copy-url", label: "Copy link to this page", icon: Link2, run: () => copyText(window.location.href) },
        { id: "search-all", label: "Search Ensemble", icon: Search, hint: "Ctrl+K", run: () => openPalette() },
        { id: "ask-view", label: "Ask Ensemble about this", icon: Sparkles, run: () => attachToAssistant({ prompt: "" }) },
      ],
    });
  }
  return { title: picked ? `“${short(picked)}”` : link ? short(link.innerText || link.href) : viewTitle(), sections };
}

// ── tasks ───────────────────────────────────────────────────────────────────

type TaskDeps = {
  client: QueryClient;
  /** Opens it beside the current page. */
  peek?: (id: string) => void;
  /** The place's own delete (with its undo); else the task goes to Trash here. */
  remove?: (id: string) => void;
  /** Applies a change through the place's own update (optimistic); else it saves here. */
  update?: (data: Record<string, unknown>) => unknown;
  toast: (text: string, options?: { tone?: "ok" | "error" }) => void;
};

const NODE_DOING: Record<string, string> = { thinking: "is working on this now", plan: "is running a plan for this", session: "has an agent session on this" };

function refreshTask(client: QueryClient, id: string) {
  void client.invalidateQueries({ queryKey: ["tasks"] });
  void client.invalidateQueries({ queryKey: ["task", id] });
  void client.invalidateQueries({ queryKey: ["boards"] });
  void client.invalidateQueries({ queryKey: ["pages"] });
}

/** Who the task can go to: me, the agent, nobody, the space's people, my nodes and crews. */
async function assignOptions(client: QueryClient, task: TaskRecord) {
  const shell = await client.fetchQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const space = shell.space;
  const shared = Boolean(space && ((space.members ?? 0) > 0 || space.shared));
  const members = shared && space ? await client.fetchQuery({ queryKey: ["space-members", space.id], queryFn: () => api.spaceMembers(space.id), staleTime: 60_000 }).catch(() => null) : null;
  const mine = await client.fetchQuery({ queryKey: ["node-assignable"], queryFn: api.nodeAssignable, staleTime: 60_000 }).catch(() => NO_NODES);
  const me = shell.user.id;
  const people = members ? [members.owner, ...members.members].filter((person) => person.id !== me) : [];
  const current = task.owner === "me" ? `person:${task.assigneeAccountId ?? me}` : task.owner === "node" ? (task.assigneeNodeId ? `node:${task.assigneeNodeId}` : `crew:${task.assigneeRoomId}`) : task.owner;
  return {
    current,
    options: [
      { id: `person:${me}`, label: "Me", data: { owner: "me" } as Record<string, unknown> },
      { id: "agent", label: "Agent", data: { owner: "agent" } },
      { id: "unassigned", label: "Unassigned", data: { owner: "unassigned" } },
      ...people.map((person) => ({ id: `person:${person.id}`, label: person.name, data: { assignee: person.id } as Record<string, unknown> })),
      ...mine.nodes.map((node) => ({ id: `node:${node.id}`, label: `${node.name} · @${node.slug}`, data: { owner: "node", assigneeNodeId: node.id, assigneeRoomId: null } as Record<string, unknown> })),
      ...mine.crews.map((crew) => ({ id: `crew:${crew.roomId}`, label: `${crew.title} (crew)`, data: { owner: "node", assigneeNodeId: null, assigneeRoomId: crew.roomId } as Record<string, unknown> })),
    ],
  };
}

/** A task's menu: open it, give it to someone, move it, set its priority and due date, attach it, delete it. */
export function taskMenu(task: TaskRecord, deps: TaskDeps, options: { open?: boolean; move?: MenuAction } = {}): MenuSection[] {
  const { client, toast } = deps;
  const save = async (data: Record<string, unknown>) => {
    if (deps.update) return deps.update(data);
    await api.patchTask(task.id, data);
    refreshTask(client, task.id);
  };
  const tab: MenuAction = { id: "task-tab", label: "Open in new tab", icon: ExternalLink, run: () => window.open(`/tasks/${task.id}`, "_blank", "noopener") };
  // The task already open here: only a new tab is left to offer.
  const open: MenuAction[] = options.open === false ? [tab] : [...(deps.peek ? [{ id: "task-peek", label: "Open in side peek", icon: PanelRight, run: () => deps.peek!(task.id) }] : []), tab];
  const assign: MenuAction = {
    id: "task-assign",
    label: "Assign to",
    icon: UserRound,
    submenu: async () => {
      const { current, options: choices } = await assignOptions(client, task);
      return {
        search: "Assign to…",
        sections: withRecent("assign", choices, (choice) => ({
          id: `assign-${choice.id}`,
          label: choice.label,
          keywords: choice.id.startsWith("node:") ? "node" : choice.id.startsWith("crew:") ? "crew node" : "",
          checked: choice.id === current,
          // Away from a node that has started: say what stops first.
          confirm: async () => {
            if (task.owner !== "node" || choice.id === current) return null;
            const work = (await api.nodeTaskWork(task.id).catch(() => null))?.work;
            return work ? { title: `@${work.node.slug} ${NODE_DOING[work.doing] ?? "is working on this"}`, body: "Changing the owner stops that work where it is.", action: "Stop and change", danger: true } : null;
          },
          run: async () => {
            if (choice.id === current) return;
            rememberPick("assign", choice.id);
            await save(choice.data);
          },
        })),
      };
    },
  };
  const move: MenuAction = {
    id: "task-move",
    label: "Move to",
    icon: Columns3,
    submenu: () => ({
      sections: [
        {
          items: (["proposed", "todo", "in_progress", "done"] as const).map((status) => ({
            id: `move-${status}`,
            label: STATUS[status].label,
            checked: task.status === status,
            run: async () => {
              if (task.status === status) return;
              await api.moveTask(task.id, { status });
              refreshTask(client, task.id);
            },
          })),
        },
      ],
    }),
  };
  const priority: MenuAction = {
    id: "task-priority",
    label: "Priority",
    icon: Flag,
    submenu: () => ({ sections: [{ items: PRIORITY_ORDER.map((value) => ({ id: `priority-${value}`, label: PRIORITY[value].label, checked: task.priority === value, run: () => save({ priority: value }) })) }] }),
  };
  const due: MenuAction = {
    id: "task-due",
    label: "Due date",
    icon: CalendarDays,
    submenu: () => ({
      width: 272,
      render: (close) => (
        <Calendar
          value={task.due ? dayKey(new Date(task.due)) : ""}
          close={close}
          onPick={(day) => void Promise.resolve(save({ due: new Date(`${day}T17:00:00`).toISOString() })).catch((error: Error) => toast(error.message, { tone: "error" }))}
          onClear={() => void Promise.resolve(save({ due: null })).catch((error: Error) => toast(error.message, { tone: "error" }))}
        />
      ),
    }),
  };
  return [
    { items: open },
    { items: [assign, options.move ?? move, priority, due] },
    {
      items: [
        { id: "task-attach", label: "Attach to assistant", icon: Paperclip, run: () => attachToAssistant({ mention: { kind: "task", id: task.id, label: task.title || "Untitled" } }) },
        { id: "task-link", label: "Copy link", icon: Link2, run: async () => { await copyText(absolute(`/tasks/${task.id}`)); toast("Link copied.", { tone: "ok" }); } },
      ],
    },
    {
      items: [
        {
          id: "task-delete",
          label: "Delete",
          icon: Trash2,
          danger: true,
          run: async () => {
            if (deps.remove) return deps.remove(task.id);
            await api.deleteTask(task.id);
            refreshTask(client, task.id);
            toast("Task moved to Trash.", { tone: "ok" });
          },
        },
      ],
    },
  ];
}

// ── pages ───────────────────────────────────────────────────────────────────

type PageDeps = {
  client: QueryClient;
  navigate: (href: string) => void;
  peek?: (id: string) => void;
  rename?: () => void;
  remove?: () => void;
  /** Saves what is being typed before a duplicate or export reads the page. */
  before?: () => Promise<unknown>;
  toast: (text: string, options?: { tone?: "ok" | "error" }) => void;
};

/** "Move to ▸": a board and column, searchable, recent first. */
export function boardSubmenu(kind: "page" | "task", id: string, client: QueryClient, toast: PageDeps["toast"]): MenuAction {
  return {
    id: `${kind}-board`,
    label: "Move to board",
    icon: Columns3,
    submenu: async () => {
      const { boards } = await client.fetchQuery({ queryKey: ["boards"], queryFn: api.boards, staleTime: 30_000 });
      const places = boards.flatMap((board) => board.columns.map((column) => ({ id: `${board.id}:${column.id}`, label: `${board.title} · ${column.name}`, boardId: board.id, columnId: column.id })));
      return {
        search: "Move to…",
        sections: places.length
          ? withRecent("move", places, (place) => ({
              id: `board-${place.id}`,
              label: place.label,
              run: async () => {
                rememberPick("move", place.id);
                await api.assignPageBoard(kind, id, { boardId: place.boardId, columnId: place.columnId });
                void client.invalidateQueries({ queryKey: ["boards"] });
                void client.invalidateQueries({ queryKey: ["pages"] });
                toast(`Moved to ${place.label}.`, { tone: "ok" });
              },
            }))
          : [{ items: [{ id: "no-boards", label: "No boards yet", disabled: true }] }],
      };
    },
  };
}

/** A page's menu: open it, copy its link, attach it, rename, duplicate, move to a board, download, delete. */
export function pageMenu(page: { id: string; title: string }, deps: PageDeps, options: { open?: boolean } = {}): MenuSection[] {
  const { client, toast } = deps;
  const href = `/pages/${page.id}`;
  const attachment: AssistantAttachment = { text: "", source: { kind: "page", id: page.id, title: page.title || "Untitled" } };
  const tab: MenuAction = { id: "page-tab", label: "Open in new tab", icon: ExternalLink, run: () => window.open(href, "_blank", "noopener") };
  return [
    {
      // The page already open here: only a new tab is left to offer.
      items:
        options.open === false
          ? [tab]
          : [{ id: "page-open", label: "Open", icon: ArrowUpRight, run: () => deps.navigate(href) }, ...(deps.peek ? [{ id: "page-peek", label: "Open in side peek", icon: PanelRight, run: () => deps.peek!(page.id) }] : []), tab],
    },
    {
      items: [
        { id: "page-attach", label: "Attach to assistant", icon: Paperclip, run: () => attachToAssistant({ attachment }) },
        { id: "page-link", label: "Copy link", icon: Link2, run: async () => { await copyText(absolute(href)); toast("Link copied.", { tone: "ok" }); } },
      ],
    },
    {
      items: [
        ...(deps.rename ? [{ id: "page-rename", label: "Rename", icon: Pencil, run: deps.rename }] : []),
        {
          id: "page-duplicate",
          label: "Duplicate",
          icon: CopyPlus,
          run: async () => {
            await deps.before?.();
            const { page: copy } = await api.duplicatePage(page.id);
            void client.invalidateQueries({ queryKey: ["pages"] });
            deps.navigate(`/pages/${copy.id}`);
          },
        },
        boardSubmenu("page", page.id, client, toast),
        {
          id: "page-export",
          label: "Download as",
          icon: Download,
          submenu: () => ({
            sections: [
              {
                items: DOC_FORMATS.map((format) => ({
                  id: `export-${format.id}`,
                  label: format.label,
                  hint: format.hint,
                  run: async () => {
                    await deps.before?.();
                    await downloadDocument(pageDoc(await api.standalonePage(page.id)), format.id);
                  },
                })),
              },
            ],
          }),
        },
      ],
    },
    ...(deps.remove ? [{ items: [{ id: "page-delete", label: "Delete", icon: Trash2, danger: true, run: deps.remove }] }] : []),
  ];
}

/** A task known by id and title only (a sidebar row, a board card): its full menu once its record is cached, else the basics. */
export function taskMenuFor(row: { id: string; title: string }, deps: TaskDeps): MenuSection[] {
  const cached = deps.client.getQueryData<{ task: TaskRecord }>(["task", row.id])?.task ?? deps.client.getQueryData<{ tasks: TaskRecord[] }>(["tasks"])?.tasks.find((task) => task.id === row.id);
  if (cached) return taskMenu({ ...cached, title: row.title || cached.title }, deps);
  return [
    { items: [...(deps.peek ? [{ id: "task-peek", label: "Open in side peek", icon: PanelRight, run: () => deps.peek!(row.id) }] : []), { id: "task-tab", label: "Open in new tab", icon: ExternalLink, run: () => window.open(`/tasks/${row.id}`, "_blank", "noopener") }] },
    {
      items: [
        { id: "task-attach", label: "Attach to assistant", icon: Paperclip, run: () => attachToAssistant({ mention: { kind: "task", id: row.id, label: row.title || "Untitled" } }) },
        { id: "task-link", label: "Copy link", icon: Link2, run: async () => { await copyText(absolute(`/tasks/${row.id}`)); deps.toast("Link copied.", { tone: "ok" }); } },
      ],
    },
    ...(deps.remove ? [{ items: [{ id: "task-delete", label: "Delete", icon: Trash2, danger: true, run: () => deps.remove!(row.id) }] }] : []),
  ];
}

/** A link to a screen (the sidebar's): open it here or in a new tab, or copy its address. */
export function navMenu(href: string, label: string, navigate: (href: string) => void): MenuSpec {
  return {
    title: label,
    sections: [
      {
        items: [
          { id: "nav-open", label: "Open", icon: ArrowUpRight, run: () => navigate(href) },
          { id: "nav-tab", label: "Open in new tab", icon: ExternalLink, run: () => window.open(href, "_blank", "noopener") },
          { id: "nav-copy", label: "Copy link", icon: Link2, run: () => copyText(absolute(href)) },
        ],
      },
    ],
  };
}

/** The sidebar's own space: a new page or task, search, settings. */
export function sidebarMenu(deps: { client: QueryClient; navigate: (href: string) => void; toast: TaskDeps["toast"] }): MenuSpec {
  return {
    title: "Sidebar",
    sections: [
      {
        items: [
          {
            id: "new-page",
            label: "New page",
            icon: FileText,
            run: async () => {
              const { page } = await api.createPage();
              void deps.client.invalidateQueries({ queryKey: ["pages"] });
              deps.navigate(`/pages/${page.id}?focus=title`);
            },
          },
          {
            id: "new-task",
            label: "New task",
            icon: ListTodo,
            run: async () => {
              const { task } = await api.createTask({ title: "Untitled", status: "todo" });
              void deps.client.invalidateQueries({ queryKey: ["tasks"] });
              deps.navigate(`/tasks/${task.id}`);
            },
          },
        ],
      },
      {
        items: [
          { id: "search", label: "Search Ensemble", icon: Search, hint: "Ctrl+K", run: () => openPalette() },
          { id: "settings", label: "Settings", icon: Settings, run: () => deps.navigate("/settings") },
        ],
      },
    ],
  };
}
