"use client";
import { PageBoardPicker } from "../pages/page-board-picker";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AgentIcon as Orbit } from "@/components/agent-icon";
import {
  History,
  Calendar,
  CheckSquare,
  ChevronRight,
  ExternalLink,
  FileText,
  FolderKanban,
  Gauge,
  MessageSquare,
  MoreHorizontal,
  Pin,
  PinOff,
  Tag as TagIcon,
  Trash2,
  User,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { createContext, useContext, useId, useCallback, useEffect, useRef, useState } from "react";
import type { PageMention } from "@ensemble/shared-types";
import { ApiError, api, currentLink, currentShare, type TaskRecord, type TaskStatus } from "@/lib/api";
import { useEntities } from "@/lib/entities";
import { COMPLEXITY_LABEL, OWNER_LABEL, PRIORITY, PRIORITY_ORDER, STATUS, dateTime } from "@/lib/format";
import { MakeDiagramButton, taskDiagramPrompt } from "../diagrams/make-diagram";
import { HumanDescription } from "../pages/human-description";
import { useQuickAssign } from "../agent/use-quick-assign";
import { AssignDialog } from "../agent/assign-dialog";
import { TaskAgentPanel } from "../agent/job-card";
import { TaskHandoffs } from "../agent/handoff-card";
import { textToDoc } from "../editor/doc";
import { mentionHref } from "../editor/editor-commands";
import { usePeek } from "../shell/peek";
import { blockEditor, warmPeek } from "@/lib/warm";
import { useToast } from "../toast";
import { TaskSkeleton } from "@/components/motion/skeletons";
import { useDelayedFlag } from "@/lib/motion/use-delayed-flag";
import { useModuleOn } from "@/lib/use-module";
import { MenuItem, Popover, PriorityTag, Tag, cx } from "../ui";
import { PageContent } from "../pages/page-content";
import { PageTitleField } from "../pages/title-field";
import { PageLoadFailure, inTrash } from "../pages/page-load";
import { TrashedTask } from "../pages/trashed-page";
import { isPageEnsembleBusy } from "../comments/ensemble-bus";
import { LabelEditor } from "./labels";
import { DueDateField } from "./due-date-field";
import { FromMeeting } from "../meetings/from-meeting";
import { AttachedItems } from "../app-items/attached-items";
import { PostUpdate } from "../app-items/post-update";
import { useSpaceAccess } from "@/lib/access";
import { announceTyping, onResource, tabId, usePresence } from "@/lib/presence";
import { PagePeople } from "../sharing/page-people";
import { ShareButton } from "../sharing/share-dialog";
import { taskPersonId, useSpacePeople } from "@/lib/space-people";
import { colorFor } from "@/lib/presence";
import { TaskExportMenu } from "./task-export";
import { SourceFileBanner, exportBackItems } from "../files/source-file-banner";
import { PAGE_FOCUS_CLASS, PageFocusBar, PageFocusButton, usePageFocus } from "../pages/page-focus";
import { collabStatusText, useCollab } from "../pages/use-collab";
import { PageHistory } from "../pages/page-history";
import { KeptEdits } from "../pages/kept-edits";

function useBlockEditor() {
  const [Editor, setEditor] = useState(() => blockEditor);
  useEffect(() => {
    if (Editor) return;
    let live = true;
    void warmPeek().then(() => {
      if (live && blockEditor) setEditor(() => blockEditor);
    });
    return () => {
      live = false;
    };
  }, [Editor]);
  return Editor;
}

const PropertyLabel = createContext<string | undefined>(undefined);

function PropertyRow({ icon: Icon, label, children }: { icon: typeof User; label: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <PropertyLabel.Provider value={id}>
    <div className="flex min-h-[32px] items-start gap-2 text-[13.5px]" data-property-row>
      <div id={id} className="flex h-8 w-[124px] shrink-0 items-center gap-2 whitespace-nowrap text-muted">
        <Icon size={14} strokeWidth={1.8} />
        {label}
      </div>
      <div className="flex min-h-8 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 py-1">{children}</div>
    </div>
    </PropertyLabel.Provider>
  );
}

function ValueButton({ onClick, empty, children }: { onClick: () => void; empty?: boolean; children: React.ReactNode }) {
  const label = useContext(PropertyLabel);
  const id = useId();
  return (
    <button
      id={id}
      aria-labelledby={label ? `${label} ${id}` : undefined}
      type="button"
      onClick={onClick}
      title={typeof children === "string" ? children : undefined}
      className={cx("row-tile inline-flex min-w-0 max-w-full items-center gap-1.5 rounded px-1.5 py-0.5", empty && "text-faint")}
    >
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

export function TaskPage({
  taskId,
  variant,
  shared,
}: {
  taskId: string;
  variant: "peek" | "page";
  /** Opened from a share link: the task and its page only, read-only unless it may be edited. A public link edits the page, never the properties. `gone`: the owner stopped sharing it while it was open. */
  shared?: { role: "view" | "edit"; link?: boolean; gone?: boolean };
}) {
  const client = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const peek = usePeek();
  const entities = useEntities();
  const Editor = useBlockEditor();
  const [leaving, setLeaving] = useState(false);
  const task = useQuery({ queryKey: ["task", taskId], queryFn: () => api.task(taskId), enabled: !leaving });
  const page = useQuery({ queryKey: ["page", taskId], queryFn: () => api.page(taskId), refetchOnWindowFocus: false, enabled: !leaving });
  // The rest of the space is not reachable from a shared item or a public link.
  const whole = !shared;
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects, enabled: whole });
  const people = useQuery({ queryKey: ["people"], queryFn: api.people, enabled: whole });
  const repos = useQuery({ queryKey: ["repos"], queryFn: api.repos, enabled: whole });
  const deliverables = useQuery({ queryKey: ["deliverables", "all"], queryFn: () => api.deliverables(true), enabled: whole });
  const skillsOn = useModuleOn("skills");
  const skills = useQuery({ queryKey: ["skills"], queryFn: api.skills, enabled: skillsOn && whole });

  const [propsState, setPropsState] = useState<"saved" | "saving">("saved");
  const [linkedOpen, setLinkedOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const titleSave = useRef<Promise<unknown> | null>(null);
  // The share (or none) this task was opened under. Its saves, the last one on leaving too, go there.
  const openedAs = useRef(currentShare());
  const openedLink = useRef(currentLink());
  const propertiesBusy = useRef(0);
  const propertyWaiters = useRef<Array<() => void>>([]);
  const access = useSpaceAccess();
  // "gone": the share was removed; "view": you may still open it but no longer edit it.
  const [lost, setLost] = useState<"gone" | "view" | null>(null);
  const gone = Boolean(shared?.gone) || lost === "gone";
  const locked = gone || lost === "view";
  const canEdit = !locked && (shared ? shared.role === "edit" : access.canEdit);
  const canEditProperties = canEdit && !shared?.link;
  // Who it is with, relative to you: "Me", or another person in a shared space.
  const space = useSpacePeople();
  const others = space.people.filter((person) => person.id !== space.me);
  const othersHere = onResource(usePresence(), "task", taskId).length > 0;
  const watching = Boolean(shared) || othersHere;
  const watchingRef = useRef(watching);
  watchingRef.current = watching;
  // Focus mode is for the task's own page, not the side peek.
  const focusMode = usePageFocus(variant === "page");
  const sync = useCollab({
    kind: "task",
    // Not while the page is loading, in Trash or missing; it joins as soon as it opens (after Restore, say).
    enabled: Boolean(page.data),
    id: taskId,
    share: openedAs.current,
    link: openedLink.current,
    live: othersHere,
    frozen: locked,
    onLost: (error) => setLost(error.code === "SHARE_GONE" ? "gone" : "view"),
    onError: (message) => toast(message, { tone: "error" }),
    onRestored: () => toast("Changes you made before were not saved yet. They are back on the page and saving now."),
  });
  const { flush } = sync;
  // The editor opens on the live document; everyone's changes arrive in it as they are typed.
  const initialDoc = sync.joined?.doc ?? null;

  const update = useMutation({
    mutationFn: (data: Record<string, unknown>) => api.patchTask(taskId, data),
    onMutate: async (data) => {
      propertiesBusy.current += 1;
      setPropsState("saving");
      await client.cancelQueries({ queryKey: ["task", taskId] });
      const previous = client.getQueryData<{ task: TaskRecord }>(["task", taskId]);
      if (previous) client.setQueryData(["task", taskId], { task: { ...previous.task, ...data } });
      return { previous };
    },
    onError: (error, _data, context) => {
      if (context?.previous) client.setQueryData(["task", taskId], context.previous);
      toast((error as Error).message, { tone: "error" });
    },
    onSettled: () => {
      propertiesBusy.current -= 1;
      if (!propertiesBusy.current) {
        propertyWaiters.current.splice(0).forEach((resolve) => resolve());
      }
      setPropsState(propertiesBusy.current ? "saving" : "saved");
      void client.invalidateQueries({ queryKey: ["tasks"] });
      void client.invalidateQueries({ queryKey: ["task", taskId] });
      void client.invalidateQueries({ queryKey: ["desk-live"] });
      void client.invalidateQueries({ queryKey: ["home"] });
    },
  });

  const params = useSearchParams();
  const [assigning, setAssigning] = useState(() => params.get("assign") === "1");
  const [editingDescription, setEditingDescription] = useState(false);
  const quickAssign = useQuickAssign(() => setAssigning(true));
  useEffect(() => {
    if (shared || !canEdit) return;
    const key = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== "a" || event.altKey) return;
      if (assigning || quickAssign.isPending || (variant === "page" && peek.peekId) || document.querySelector("[data-modal-layer]")) return;
      if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault();
      quickAssign.mutate(taskId);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [taskId, shared, canEdit, assigning, quickAssign.isPending, peek.peekId, variant, quickAssign.mutate]);

  const remove = useMutation({
    onMutate: () => setLeaving(true),
    mutationFn: async () => {
      if (titleSave.current) await titleSave.current;
      while (propertiesBusy.current) await new Promise<void>((resolve) => propertyWaiters.current.push(resolve));
      if (!(await flush())) throw new Error("Save the task page before moving it to Trash.");
      return api.deleteTask(taskId);
    },
    onSuccess: (result) => {
      toast("Moved to Trash.", {
        action: result?.undoEntryId
          ? {
              label: "Undo",
              run: () => {
                void api
                  .undo(result.undoEntryId ?? undefined)
                  .then(() => client.invalidateQueries())
                  .catch((error: Error) => toast(error.message, { tone: "error" }));
              },
            }
          : undefined,
      });
      void client.invalidateQueries({ queryKey: ["tasks"] });
      void client.invalidateQueries({ queryKey: ["pages"] });
      void client.invalidateQueries({ queryKey: ["boards"] });
      if (variant === "peek") peek.close();
      else router.push("/board");
    },
    onError: (error: Error) => { setLeaving(false); toast(error.message, { tone: "error" }); },
  });
  const deleteFromPages = useRef(() => remove.mutate());
  deleteFromPages.current = () => { if (!remove.isPending) remove.mutate(); };
  useEffect(() => {
    const handler = (event: Event) => {
      if ((event as CustomEvent<{ id: string }>).detail.id !== taskId || shared || !canEdit) return;
      event.preventDefault();
      deleteFromPages.current();
    };
    window.addEventListener("ensemble:delete-task", handler);
    return () => window.removeEventListener("ensemble:delete-task", handler);
  }, [taskId, shared, canEdit]);

  const convert = useMutation({
    onMutate: () => setLeaving(true),
    mutationFn: async () => {
      if (isPageEnsembleBusy("task", taskId)) throw new Error("Wait for Ensemble to finish before converting this task.");
      if (titleSave.current) await titleSave.current;
      while (propertiesBusy.current) {
        await new Promise<void>((resolve) => propertyWaiters.current.push(resolve));
      }
      if (!(await flush())) throw new Error("Save the task page before converting it.");
      return api.convertPage("task", taskId, sync.revision());
    },
    onSuccess: (result) => {
      void client.invalidateQueries();
      router.push(`/pages/${result.id}`);
    },
    onError: (error: Error) => {
      setLeaving(false);
      toast(error.message, { tone: "error" });
    },
  });

  const onChange = useCallback(() => {
    if (watchingRef.current) announceTyping((typing) => api.sendPresence({ tabId: tabId(), typing }));
  }, []);

  const exitFocus = focusMode.exit;
  const onMentionClick = useCallback(
    (mention: PageMention) => {
      if (mention.kind === "task") {
        // The side peek opens under focus mode's layer, so leave focus mode first.
        exitFocus();
        peek.open(mention.id);
      } else {
        const href = mentionHref(mention);
        if (href) router.push(href);
      }
    },
    [peek, router, exitFocus],
  );

  const taskPending = task.isLoading || page.isLoading;
  const taskHold = useDelayedFlag(taskPending);
  if (taskPending || taskHold) {
    return <TaskSkeleton peek={variant === "peek"} />;
  }
  if (!task.data) {
    if (!shared && inTrash(task.error)) return <TrashedTask taskId={taskId} onRestored={() => { void task.refetch(); void page.refetch(); }} />;
    const missing = task.error instanceof ApiError && task.error.status === 404;
    return <PageLoadFailure kind="task" missing={missing} links={!shared} error={task.error} retrying={task.isFetching} onRetry={() => void task.refetch()} />;
  }

  const record = task.data.task;
  const project = projects.data?.projects.find((row) => row.id === record.projectId);
  const repo = repos.data?.repos.find((row) => row.id === record.repoId);
  const deliverable = deliverables.data?.deliverables.find((row) => row.id === record.deliverableId);
  const personName = (value: string) => people.data?.people.find((row) => row.id === value)?.name ?? value;
  const pinned = record.todayFocus === "keep";
  const personId = taskPersonId(record, space.ownerId) ?? space.me;
  const ownerText =
    record.owner !== "me" ? OWNER_LABEL[record.owner] : personId === space.me ? "Me" : (space.byId.get(personId ?? "")?.name ?? "Someone");
  const source = page.data?.sourceFile ?? null;
  const pageNow = () => ({ title: record.title || "Untitled", doc: sync.latest() ?? page.data?.content ?? textToDoc(page.data?.notes ?? "") });

  const saveState = sync.status;
  const unsaved = saveState !== "saved";
  const saveText = collabStatusText(saveState, locked);

  return (
    <div
      ref={focusMode.layer}
      tabIndex={focusMode.active ? -1 : undefined}
      className={
        focusMode.active
          ? PAGE_FOCUS_CLASS
          : cx("mx-auto w-full pb-24", variant === "peek" ? "max-w-[860px] px-4 pt-4 sm:px-8 sm:pt-6" : "max-w-[900px] px-4 pt-6 sm:px-16 sm:pt-10")
      }
      inert={leaving}
      data-page-focus={focusMode.active ? "true" : undefined}
    >
      {focusMode.active ? <PageFocusBar status={saveText} error={saveState === "error"} onExit={focusMode.exit} /> : null}
      {variant === "page" ? (
        <div className="-mb-1 flex flex-wrap justify-end gap-1">
          <PageFocusButton onEnter={focusMode.enter} />
          <TaskExportMenu taskId={taskId} extra={exportBackItems(source, pageNow)} />
          {shared ? null : <ShareButton compact target={{ kind: "task", resourceId: taskId, title: record.title }} />}
        </div>
      ) : null}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-muted">
        <div className="flex items-center gap-1">
          <Link href="/board" className="hover:text-ink">
            Task
          </Link>
          <span>/</span>
          <Popover
            trigger={(_open, toggle) => (
              <button type="button" onClick={toggle} className="row-tile rounded px-1 hover:text-ink">
                {STATUS[record.status].label.toLowerCase()}
              </button>
            )}
          >
            {(close) =>
              (Object.keys(STATUS) as TaskStatus[]).map((status) => (
                <MenuItem
                  key={status}
                  active={record.status === status}
                  onClick={() => {
                    close();
                    void api
                      .moveTask(taskId, { status })
                      .then(() => client.invalidateQueries())
                      .catch((error: Error) => toast(error.message, { tone: "error" }));
                  }}
                >
                  <Tag tone={STATUS[status].tone}>{STATUS[status].label}</Tag>
                </MenuItem>
              ))
            }
          </Popover>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PagePeople kind="task" id={taskId} />
          {!shared && !access.guest ? <><button type="button" className="icon-btn" title="Version history" aria-label="Version history" onClick={() => { void (async () => { if (titleSave.current) await titleSave.current; await sync.flush(); setHistoryOpen(true); })().catch((error: Error) => toast(error.message, { tone: "error" })); }}><History size={14} /></button><PageHistory kind="task" id={taskId} open={historyOpen} onClose={() => setHistoryOpen(false)} /></> : null}
          {shared ? <span className="whitespace-nowrap">{canEdit ? "Shared with you · can edit" : "Shared with you · view only"}</span> : !canEdit ? <span className="whitespace-nowrap">View only</span> : null}
          {canEditProperties && propsState === "saving" ? <span role="status">Saving…</span> : null}
          {shared || !canEdit ? null : (
          <>
          <Popover align="right" trigger={(open, toggle) => <button type="button" className="icon-btn" aria-label="More task actions" aria-expanded={open} onClick={toggle}><MoreHorizontal size={16} /></button>}>
            {close => <>
              <MenuItem onClick={() => { close(); update.mutate({ todayFocus: pinned ? "auto" : "keep" }); }}>{pinned ? <PinOff size={13} /> : <Pin size={13} />}{pinned ? "Unpin from Today" : "Pin to Today"}</MenuItem>
              <MenuItem onClick={() => { close(); window.dispatchEvent(new CustomEvent("ensemble:page-comment")); }}><MessageSquare size={13} />Comment</MenuItem>
              {!record.description ? <MenuItem onClick={() => { close(); setEditingDescription(true); }}>Add description</MenuItem> : null}
              <div className="px-2 py-1"><PageBoardPicker kind="task" id={taskId} /></div>
              <div className="px-2 py-1" onClick={close}><MakeDiagramButton text={taskDiagramPrompt(taskId, record.title)} /></div>
              <MenuItem disabled={remove.isPending} onClick={() => { close(); remove.mutate(); }}><Trash2 size={13} />Move to Trash</MenuItem>
            </>}
          </Popover>
          <span className="inline-flex items-center gap-2 whitespace-nowrap">
            <button type="button" className="btn-ghost" disabled={convert.isPending} onClick={() => convert.mutate()}>
              <FileText size={13} /> Convert to page
            </button>
          </span>
          </>
          )}
        </div>
      </div>

      {source ? <SourceFileBanner source={source} page={pageNow} /> : null}
      <div data-focus-keep data-peek-escape>
        {canEditProperties ? (
          <PageTitleField value={record.title} autoFocus={record.title === "Untitled"} onSave={(title) => {
            titleSave.current = update.mutateAsync({ title });
            void titleSave.current.catch(() => undefined);
          }} />
        ) : (
          <h1 className="text-[32px] font-semibold leading-tight tracking-tight">{record.title || "Untitled"}</h1>
        )}
      </div>

      <div className="mt-5 space-y-0.5" inert={!canEditProperties || undefined}>
        <PropertyRow icon={User} label="Owner">
          <Popover
            trigger={(_open, toggle) => <ValueButton onClick={toggle}>{ownerText}</ValueButton>}
            width={220}
          >
            {(close) => (
              <>
                {(["me", "agent", "unassigned"] as const).map((owner) => (
                  <MenuItem
                    key={owner}
                    active={record.owner === owner && (owner !== "me" || personId === space.me)}
                    onClick={() => {
                      close();
                      update.mutate({ owner });
                    }}
                  >
                    {OWNER_LABEL[owner]}
                  </MenuItem>
                ))}
                {others.length ? <div className="mx-2 my-1 border-t border-line" /> : null}
                {others.map((person) => (
                  <MenuItem
                    key={person.id}
                    active={record.owner === "me" && personId === person.id}
                    onClick={() => {
                      close();
                      update.mutate({ assignee: person.id });
                    }}
                  >
                    <span className="grid h-[18px] min-w-[22px] place-items-center rounded-full px-1 text-[10.5px] font-semibold text-white" style={{ background: colorFor(person.id) }}>
                      {person.initials}
                    </span>
                    {person.name}
                  </MenuItem>
                ))}
              </>
            )}
          </Popover>
          {shared ? null : record.owner === "agent" ? (
            <>
              <button type="button" className="btn-ghost" onClick={() => setAssigning(true)}>
                <Orbit size={13} />
                New agent attempt
              </button>
              <button type="button" className="btn-ghost" onClick={() => update.mutate({ owner: "me" })}>
                Take over
              </button>
            </>
          ) : (
            <button type="button" className="btn-ghost" onClick={() => setAssigning(true)}>
              <Orbit size={13} />
              Agent does it
            </button>
          )}
          {!shared && canEditProperties ? <button type="button" className="btn-ghost text-accent" disabled={quickAssign.isPending} title="Use the default run profile · ⌘/Ctrl+Shift+A" onClick={() => quickAssign.mutate(taskId)}><Orbit size={13} /> {quickAssign.isPending ? "Assigning…" : "Quick assign"}</button> : null}
        </PropertyRow>

        <PropertyRow icon={Gauge} label="Priority">
          <Popover
            trigger={(_open, toggle) => (
              <ValueButton onClick={toggle}>
                <PriorityTag priority={record.priority} />
              </ValueButton>
            )}
            width={160}
          >
            {(close) =>
              PRIORITY_ORDER.map((priority) => (
                <MenuItem
                  key={priority}
                  active={record.priority === priority}
                  onClick={() => {
                    close();
                    update.mutate({ priority });
                  }}
                >
                  <Tag tone={PRIORITY[priority].tone}>{PRIORITY[priority].label}</Tag>
                </MenuItem>
              ))
            }
          </Popover>
        </PropertyRow>

        <PropertyRow icon={Gauge} label="Complexity">
          <Popover
            trigger={(_open, toggle) => (
              <span title="Complexity picks the model tier set in Settings → Models">
                <ValueButton onClick={toggle}>{COMPLEXITY_LABEL[record.complexity]}</ValueButton>
              </span>
            )}
            width={220}
          >
            {(close) =>
              (["easy", "medium", "high", "max"] as const).map((complexity) => (
                <MenuItem
                  key={complexity}
                  active={record.complexity === complexity}
                  hint={complexity === "max" ? "slowest, best" : undefined}
                  onClick={() => {
                    close();
                    update.mutate({ complexity });
                  }}
                >
                  {COMPLEXITY_LABEL[complexity]}
                </MenuItem>
              ))
            }
          </Popover>
        </PropertyRow>

        <PropertyRow icon={Calendar} label="Due date">
          <DueDateField due={record.due} onSave={(due) => update.mutate({ due })} />
        </PropertyRow>

        <PropertyRow icon={TagIcon} label="Labels">
          <LabelEditor labels={record.labels ?? []} onChange={(labels) => update.mutate({ labels })} />
        </PropertyRow>

        <PropertyRow icon={FolderKanban} label="Project">
          <Popover
            trigger={(_open, toggle) => (
              <ValueButton onClick={toggle} empty={!project}>
                {project?.name ?? "Empty"}
              </ValueButton>
            )}
          >
            {(close) => (
              <>
                <MenuItem
                  onClick={() => {
                    close();
                    update.mutate({ projectId: null });
                  }}
                >
                  <span className="text-muted">No project</span>
                </MenuItem>
                {(projects.data?.projects ?? []).map((row) => (
                  <MenuItem
                    key={row.id}
                    active={row.id === record.projectId}
                    onClick={() => {
                      close();
                      update.mutate({ projectId: row.id });
                    }}
                  >
                    {row.name}
                  </MenuItem>
                ))}
              </>
            )}
          </Popover>
        </PropertyRow>

        <PropertyRow icon={Users} label="People">
          <Popover
            trigger={(_open, toggle) => (
              <ValueButton onClick={toggle} empty={!record.people.length}>
                {record.people.length ? (
                  record.people.map((value) => (
                    <Tag key={value} tone="blue">
                      {personName(value)}
                    </Tag>
                  ))
                ) : (
                  "Empty"
                )}
              </ValueButton>
            )}
          >
            {() =>
              (people.data?.people ?? []).length ? (
                (people.data?.people ?? []).map((row) => {
                  const on = record.people.includes(row.id);
                  return (
                    <MenuItem
                      key={row.id}
                      active={on}
                      hint={on ? "✓" : undefined}
                      onClick={() =>
                        update.mutate({
                          people: on ? record.people.filter((value) => value !== row.id) : [...record.people, row.id],
                        })
                      }
                    >
                      {row.name}
                    </MenuItem>
                  );
                })
              ) : (
                <div className="p-2 text-[12.5px] text-muted">No people yet. They appear as sources sync, or add them in Context.</div>
              )
            }
          </Popover>
        </PropertyRow>
      </div>

      <button
        type="button"
        onClick={() => setLinkedOpen((value) => !value)}
        className="mt-2 flex items-center gap-1 text-[12.5px] text-muted hover:text-ink"
      >
        <ChevronRight size={13} className={cx("transition-transform", linkedOpen && "rotate-90")} />
        Repository, deliverable &amp; skills · linked
      </button>
      {linkedOpen ? (
        <div className="mt-1 space-y-0.5 border-l border-line pl-4">
          <PropertyRow icon={FolderKanban} label="Repository">
            <Popover
              trigger={(_open, toggle) => (
                <ValueButton onClick={toggle} empty={!repo}>
                  {repo?.fullName ?? "Empty"}
                </ValueButton>
              )}
            >
              {(close) => (
                <>
                  <MenuItem onClick={() => (close(), update.mutate({ repoId: null }))}>
                    <span className="text-muted">No repository</span>
                  </MenuItem>
                  {(repos.data?.repos ?? []).map((row) => (
                    <MenuItem key={row.id} active={row.id === record.repoId} onClick={() => (close(), update.mutate({ repoId: row.id }))}>
                      {row.fullName}
                    </MenuItem>
                  ))}
                </>
              )}
            </Popover>
          </PropertyRow>
          <PropertyRow icon={CheckSquare} label="Deliverable">
            <Popover
              trigger={(_open, toggle) => (
                <ValueButton onClick={toggle} empty={!deliverable}>
                  {deliverable?.title ?? "Empty"}
                </ValueButton>
              )}
              width={300}
            >
              {(close) => (
                <>
                  <MenuItem onClick={() => (close(), update.mutate({ deliverableId: null }))}>
                    <span className="text-muted">No deliverable</span>
                  </MenuItem>
                  {(deliverables.data?.deliverables ?? []).map((row) => (
                    <MenuItem
                      key={row.id}
                      active={row.id === record.deliverableId}
                      hint={row.project.name}
                      onClick={() => (close(), update.mutate({ deliverableId: row.id }))}
                    >
                      {row.title}
                    </MenuItem>
                  ))}
                </>
              )}
            </Popover>
          </PropertyRow>
          <PropertyRow icon={Orbit} label="Skills">
            <Popover
              trigger={(_open, toggle) => (
                <ValueButton onClick={toggle} empty={!record.skillIds.length}>
                  {record.skillIds.length
                    ? record.skillIds.map((id) => (
                        <Tag key={id} tone="yellow">
                          {skills.data?.skills.find((row) => row.id === id)?.name ?? "skill"}
                        </Tag>
                      ))
                    : "Empty"}
                </ValueButton>
              )}
            >
              {() =>
                (skills.data?.skills ?? []).map((row) => {
                  const on = record.skillIds.includes(row.id);
                  return (
                    <MenuItem
                      key={row.id}
                      active={on}
                      hint={on ? "✓" : undefined}
                      onClick={() =>
                        update.mutate({
                          skillIds: on ? record.skillIds.filter((id) => id !== row.id) : [...record.skillIds, row.id],
                        })
                      }
                    >
                      {row.name}
                    </MenuItem>
                  );
                })
              }
            </Popover>
          </PropertyRow>
          {record.meetingNoteId ? <FromMeeting meetingNoteId={record.meetingNoteId} /> : null}
          {record.sourceUrl ? (
            <PropertyRow icon={ExternalLink} label="Source">
              <a href={record.sourceUrl} target="_blank" rel="noreferrer" className="row-tile -mx-1.5 rounded px-1.5 py-0.5 text-accent">
                Open in {record.sourceKind} ↗
              </a>
            </PropertyRow>
          ) : null}
        </div>
      ) : null}

      <HumanDescription value={record.description} editing={editingDescription} onEditing={setEditingDescription} onSave={(description) => update.mutate({ description })} readOnly={!canEditProperties} />

      {shared ? null : (
        <>
          <AttachedItems taskId={taskId} className="mt-4" />
          <PostUpdate taskId={taskId} className="mt-2" />
          {/* The agent's run sits right above the page it worked on. */}
          <div inert={!canEditProperties || undefined}>
            <TaskAgentPanel taskId={taskId} />
            <TaskHandoffs taskId={taskId} />
          </div>
        </>
      )}

      <PageContent status={saveText} error={saveState === "error"} before={locked && unsaved ? (
        <KeptEdits
          message={gone ? "This task isn't shared with you anymore, so your last changes weren't saved. They're still on screen." : "You can't edit this task anymore, so your last changes weren't saved. They're still on screen."}
          title={record.title}
          read={sync.latest}
          ownCopy={Boolean(shared && !shared.link)}
        />
      ) : null}>

        {sync.failure ? (
          <p className="mt-4 text-[13px] text-muted">This page could not be opened for editing. Reload to try again.</p>
        ) : initialDoc && Editor ? (
          <Editor
            key={taskId}
            initial={initialDoc}
            entities={entities.get}
            onChange={onChange}
            onMentionClick={onMentionClick}
            page={{ kind: "task", id: taskId }}
            editable={!leaving && canEdit}
            collab={sync.binding}
          />
        ) : sync.stalled ? (
          <div className="mt-4 text-[13px] text-muted" role="status">
            <p>Still connecting to this page. Reload if this takes long.</p>
            <button type="button" className="btn mt-2" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        ) : (
          <div className="skeleton mt-4 h-64 w-full" />
        )}
      </PageContent>

      <AssignDialog open={assigning} onClose={() => setAssigning(false)} taskId={taskId} />
    </div>
  );
}
