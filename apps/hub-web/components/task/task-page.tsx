"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Calendar,
  CheckSquare,
  ChevronRight,
  ExternalLink,
  FileText,
  FolderKanban,
  Gauge,
  MessageSquare,
  Pin,
  PinOff,
  Tag as TagIcon,
  Trash2,
  User,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PageDocument, PageMention } from "@ensemble/shared-types";
import { ApiError, api, currentLink, currentShare, withLink, withShare, type TaskRecord, type TaskStatus } from "@/lib/api";
import { useEntities } from "@/lib/entities";
import { COMPLEXITY_LABEL, OWNER_LABEL, PRIORITY, PRIORITY_ORDER, STATUS, dateTime, isoDate } from "@/lib/format";
import { MakeDiagramButton, taskDiagramPrompt } from "../diagrams/make-diagram";
import { AssignDialog } from "../agent/assign-dialog";
import { TaskAgentPanel } from "../agent/job-card";
import { textToDoc } from "../editor/doc";
import { mentionHref } from "../editor/editor-commands";
import { usePeek } from "../shell/peek";
import { blockEditor, warmPeek } from "@/lib/warm";
import { useToast } from "../toast";
import { TaskSkeleton } from "@/components/motion/skeletons";
import { useDelayedFlag } from "@/lib/motion/use-delayed-flag";
import { useModuleOn } from "@/lib/use-module";
import { InlineEdit, MenuItem, Popover, PriorityTag, Tag, cx } from "../ui";
import { PageTitleField } from "../pages/title-field";
import { isPageEnsembleBusy } from "../comments/ensemble-bus";
import { LabelEditor } from "./labels";
import { FromMeeting } from "../meetings/from-meeting";
import { useSpaceAccess } from "@/lib/access";
import { announceTyping, onResource, tabId, usePresence } from "@/lib/presence";
import { PagePeople } from "../sharing/page-people";
import { ShareButton } from "../sharing/share-dialog";
import { taskPersonId, useSpacePeople } from "@/lib/space-people";
import { colorFor } from "@/lib/presence";
import { TaskExportMenu } from "./task-export";

type SaveState = "saved" | "saving" | "dirty" | "error";

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

function PropertyRow({ icon: Icon, label, children }: { icon: typeof User; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[32px] items-center gap-2 text-[13.5px]">
      <div className="flex w-[124px] shrink-0 items-center gap-2 whitespace-nowrap text-muted">
        <Icon size={14} strokeWidth={1.8} />
        {label}
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function ValueButton({ onClick, empty, children }: { onClick: () => void; empty?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx("row-tile -mx-1.5 flex items-center gap-1.5 rounded px-1.5 py-0.5", empty && "text-faint")}
    >
      {children}
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
  /** Opened from a share link: the task and its page only, read-only unless it may be edited. A public link edits the page, never the properties. */
  shared?: { role: "view" | "edit"; link?: boolean };
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
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [linkedOpen, setLinkedOpen] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const revision = useRef(0);
  const pending = useRef<PageDocument | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const titleSave = useRef<Promise<unknown> | null>(null);
  // The share (or none) this task was opened under. The last save on leaving must go there.
  const openedAs = useRef(currentShare());
  const openedLink = useRef(currentLink());
  const propertiesBusy = useRef(0);
  const propertyWaiters = useRef<Array<() => void>>([]);
  const loaded = Boolean(page.data);
  const access = useSpaceAccess();
  const canEdit = shared ? shared.role === "edit" : access.canEdit;
  const canEditProperties = canEdit && !shared?.link;
  // Who it is with, relative to you: "Me", or another person in a shared space.
  const space = useSpacePeople();
  const others = space.people.filter((person) => person.id !== space.me);
  const watching = Boolean(shared) || onResource(usePresence(), "task", taskId).length > 0;
  const watchingRef = useRef(watching);
  watchingRef.current = watching;
  const [remote, setRemote] = useState<{ doc: PageDocument; stamp: number } | null>(null);

  /**
   * The editor owns the document once it is loaded. Background refetches
   * (our own saves echoing back over SSE) must not reset it; only a save
   * conflict bumps the epoch and reloads from the server.
   */
  const initialDoc = useMemo(() => {
    if (!page.data) return null;
    revision.current = page.data.revision;
    return page.data.content ?? textToDoc(page.data.notes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, loaded, epoch]);

  // Saved elsewhere (another tab, or someone you share it with): take it in place, keeping your cursor.
  useEffect(() => {
    if (!page.data || page.data.revision <= revision.current) return;
    if (pending.current || saveState === "saving" || saveState === "dirty") return;
    revision.current = page.data.revision;
    setRemote({ doc: page.data.content ?? textToDoc(page.data.notes), stamp: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.data?.revision]);

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
    },
  });

  const [assigning, setAssigning] = useState(false);

  const remove = useMutation({
    mutationFn: () => api.deleteTask(taskId),
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
      if (variant === "peek") peek.close();
      else router.push("/board");
    },
  });

  const flush = useCallback(async () => {
    while (inFlight.current) {
      if (!(await inFlight.current)) return false;
    }
    const doc = pending.current;
    if (!doc) return true;
    pending.current = null;
    setSaveState("saving");
    const work = (async () => {
      try {
        const saved = await withLink(openedLink.current, () => withShare(openedAs.current, () => api.savePage(taskId, { revision: revision.current, content: doc })));
        revision.current = saved.revision;
        setSaveState(pending.current ? "dirty" : "saved");
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          toast("This page changed in another tab. Reloaded the latest version.", { tone: "error" });
          await client.refetchQueries({ queryKey: ["page", taskId] });
          setEpoch((value) => value + 1);
        } else {
          pending.current ??= doc;
          toast((error as Error).message, { tone: "error" });
        }
        setSaveState("error");
        return false;
      }
    })();
    inFlight.current = work;
    try {
      return await work;
    } finally {
      if (inFlight.current === work) inFlight.current = null;
    }
  }, [client, taskId, toast]);

  const convert = useMutation({
    onMutate: () => setLeaving(true),
    mutationFn: async () => {
      if (isPageEnsembleBusy("task", taskId)) throw new Error("Wait for Ensemble to finish before converting this task.");
      window.clearTimeout(timer.current);
      if (titleSave.current) await titleSave.current;
      while (propertiesBusy.current) {
        await new Promise<void>((resolve) => propertyWaiters.current.push(resolve));
      }
      if (!(await flush())) throw new Error("Save the task page before converting it.");
      return api.convertPage("task", taskId, revision.current);
    },
    onSuccess: (result) => {
      void client.invalidateQueries();
      router.push(`/pages/${result.id}`);
    },
    onError: (error: Error) => {
      setLeaving(false);
      if (pending.current) timer.current = window.setTimeout(() => void flush(), 700);
      toast(error.message, { tone: "error" });
    },
  });

  const onChange = useCallback(
    (doc: PageDocument) => {
      pending.current = doc;
      setSaveState("dirty");
      if (watchingRef.current) announceTyping((typing) => api.sendPresence({ tabId: tabId(), typing }));
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), 700);
    },
    [flush],
  );

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      void flush();
    },
    [flush],
  );

  const onMentionClick = useCallback(
    (mention: PageMention) => {
      if (mention.kind === "task") peek.open(mention.id);
      else {
        const href = mentionHref(mention);
        if (href) router.push(href);
      }
    },
    [peek, router],
  );

  const taskPending = task.isLoading || page.isLoading;
  const taskHold = useDelayedFlag(taskPending);
  if (taskPending || taskHold) {
    return <TaskSkeleton peek={variant === "peek"} />;
  }
  if (!task.data) return <div className="p-10 text-muted">This task no longer exists.</div>;

  const record = task.data.task;
  const project = projects.data?.projects.find((row) => row.id === record.projectId);
  const repo = repos.data?.repos.find((row) => row.id === record.repoId);
  const deliverable = deliverables.data?.deliverables.find((row) => row.id === record.deliverableId);
  const personName = (value: string) => people.data?.people.find((row) => row.id === value)?.name ?? value;
  const pinned = record.todayFocus === "keep";
  const personId = taskPersonId(record, space.ownerId) ?? space.me;
  const ownerText =
    record.owner !== "me" ? OWNER_LABEL[record.owner] : personId === space.me ? "Me" : (space.byId.get(personId ?? "")?.name ?? "Someone");

  return (
    <div className={cx("mx-auto w-full pb-24", variant === "peek" ? "max-w-[860px] px-4 pt-4 sm:px-8 sm:pt-6" : "max-w-[900px] px-4 pt-6 sm:px-16 sm:pt-10")} inert={leaving}>
      {variant === "page" ? (
        <div className="-mb-1 flex justify-end gap-1">
          <TaskExportMenu taskId={taskId} />
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
          {shared ? <span className="whitespace-nowrap">{canEdit ? "Shared with you · can edit" : "Shared with you · view only"}</span> : !canEdit ? <span className="whitespace-nowrap">View only</span> : null}
          {canEditProperties ? <span className="whitespace-nowrap">{propsState === "saving" ? "Saving…" : "Properties saved"}</span> : null}
          {shared || !canEdit ? null : (
          <>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => update.mutate({ todayFocus: pinned ? "auto" : "keep" })}
          >
            {pinned ? <PinOff size={13} /> : <Pin size={13} />}
            {pinned ? "Unpin from Today" : "Pin to Today"}
          </button>
          <button
            type="button"
            className="btn-ghost"
            aria-label="Comment on this page"
            onClick={() => window.dispatchEvent(new CustomEvent("ensemble:page-comment"))}
          >
            <MessageSquare size={13} />
            Comment
          </button>
          <MakeDiagramButton text={taskDiagramPrompt(taskId, record.title)} />
          <button type="button" className="btn-ghost" disabled={convert.isPending} onClick={() => convert.mutate()}>
            <FileText size={13} /> Convert to page
          </button>
          <button type="button" className="icon-btn" title="Delete" onClick={() => remove.mutate()}>
            <Trash2 size={14} />
          </button>
          </>
          )}
        </div>
      </div>

      {canEditProperties ? (
        <PageTitleField value={record.title} autoFocus={record.title === "Untitled"} onSave={(title) => {
          titleSave.current = update.mutateAsync({ title });
          void titleSave.current.catch(() => undefined);
        }} />
      ) : (
        <h1 className="text-[32px] font-semibold leading-tight tracking-tight">{record.title || "Untitled"}</h1>
      )}

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
                <Bot size={13} />
                New agent attempt
              </button>
              <button type="button" className="btn-ghost" onClick={() => update.mutate({ owner: "me" })}>
                Take over
              </button>
            </>
          ) : (
            <button type="button" className="btn-ghost" onClick={() => setAssigning(true)}>
              <Bot size={13} />
              Agent does it
            </button>
          )}
        </PropertyRow>
        {shared ? null : <TaskAgentPanel taskId={taskId} />}

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
          <input
            type="date"
            value={record.due ? isoDate(new Date(record.due)) : ""}
            onChange={(event) =>
              update.mutate({ due: event.target.value ? new Date(`${event.target.value}T17:00:00`).toISOString() : null })
            }
            className={cx(
              "row-tile -mx-1.5 rounded bg-transparent px-1.5 py-0.5 text-[13.5px] outline-none",
              !record.due && "text-faint",
            )}
          />
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
          <PropertyRow icon={Bot} label="Skills">
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

      <div className="mt-4">
        <InlineEdit
          value={record.description}
          placeholder="Add a short description…"
          multiline
          onSave={(description) => update.mutate({ description })}
          className="text-[13.5px] text-muted"
        />
      </div>

      <div className="mt-6 flex items-center justify-between border-t border-line pt-3 text-[12px] text-muted">
        <span className="font-medium">Page content</span>
        <span className={saveState === "error" ? "text-danger" : undefined}>
          {saveState === "saved"
            ? "All changes saved"
            : saveState === "saving"
              ? "Saving…"
              : saveState === "dirty"
                ? "Unsaved changes"
                : "Could not save. Retry on the next edit."}
        </span>
      </div>

      <div className="mt-4">
        {initialDoc && Editor ? (
          <Editor
            key={`${taskId}-${epoch}`}
            initial={initialDoc}
            entities={entities.get}
            onChange={onChange}
            onMentionClick={onMentionClick}
            page={{ kind: "task", id: taskId }}
            editable={!leaving && canEdit}
            remote={remote}
          />
        ) : initialDoc ? (
          <div className="skeleton mt-4 h-64 w-full" />
        ) : null}
      </div>

      <AssignDialog
        open={assigning}
        onClose={() => setAssigning(false)}
        taskId={taskId}
        defaultKind={record.repoId || record.taskType === "code_change" ? "code" : undefined}
      />
    </div>
  );
}
