"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Monitor, Paperclip, RotateCw, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CHAT_FILES_MAX, fileFormat, mentionHref, type FileKind, type FileRecord, type FileUsage, type PageMention } from "@ensemble/shared-types";
import { inItemView } from "@/lib/api";
import { FILE_QUERY, filesApi, formatBytes } from "@/lib/api-files";
import { isRequestCancelled } from "@/lib/fetch-cancel";
import { mentionRanges } from "@/lib/mentions/text";
import { AddFileToMessage } from "../files/add-to-message";
import { FileIcon } from "../files/file-icon";
import { invalidateFileLists, useBlobUrl } from "../files/use-file";
import { checkUploads, type Refused } from "../files/use-uploads";
import { Popover, cx } from "../ui";

/** One file on the composer's shelf, from this computer or from Files. */
export type ChatAttachment = {
  key: string;
  name: string;
  size: number | null;
  kind: FileKind;
  state: "waiting" | "uploading" | "ready" | "failed";
  /** 0–1 while it uploads. */
  progress: number;
  /** The file in Files, once it is there. */
  fileId: string | null;
  error: string | null;
  /** A blob: URL for a picture picked on this computer. */
  preview: string | null;
  /** The picked file, so a failed upload can be retried. */
  local: File | null;
};

/** The server needs text; a message with only files says this. */
export function attachmentsOnlyMessage(count: number): string {
  return count === 1 ? "Take a look at the attached file." : "Take a look at the attached files.";
}

const mentionKey = (mention: PageMention) => JSON.stringify([mention.kind, mention.id]);

/** The typed mentions, then the attached files not already among them. */
export function withAttachedFiles(mentions: PageMention[], files: PageMention[]): PageMention[] {
  const seen = new Set<string>();
  return [...mentions, ...files].filter((mention) => {
    const key = mentionKey(mention);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Distinct files a message carries, attached or written as `@file:` mentions. */
export function fileCount(mentions: PageMention[]): number {
  return new Set(mentions.filter((mention) => mention.kind === "file").map((mention) => mention.id)).size;
}

export const tooManyFiles = (count = CHAT_FILES_MAX) => `A message can carry up to ${count} files. Remove one to add another.`;

function refusedNotice(refused: Refused[]): string | null {
  if (!refused.length) return null;
  const said = refused.slice(0, 3).map(({ file, reason }) => `${file.name}: ${reason}`);
  if (refused.length > 3) said.push(`${refused.length - 3} more were not attached.`);
  return `Not attached. ${said.join(" ")}`;
}

function picture(file: File): string | null {
  const format = fileFormat(file.name);
  if (format.kind !== "image" || !format.preview || typeof URL.createObjectURL !== "function") return null;
  return URL.createObjectURL(file);
}

function revoke(item: ChatAttachment): void {
  if (item.preview && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(item.preview);
}

function cancelled(): DOMException {
  return new DOMException("The upload was cancelled.", "AbortError");
}

/** Uploads run two at a time: each holds the whole file in memory while it is sent. */
function limiter(size: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T,>(task: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    if (signal.aborted) throw cancelled();
    if (active < size) active += 1;
    else {
      // A finishing upload hands its slot straight to the next one, so the count never goes over.
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal.removeEventListener("abort", stop);
          resolve();
        };
        const stop = () => {
          const at = waiting.indexOf(go);
          if (at >= 0) waiting.splice(at, 1);
          reject(cancelled());
        };
        waiting.push(go);
        signal.addEventListener("abort", stop, { once: true });
      });
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

let counter = 0;

/**
 * The files attached to the message being written. Uploads go to Files with progress; Cancel stops
 * the request (the server may already have kept the file), and Remove only takes it off this message.
 */
export function useChatAttachments() {
  const client = useQueryClient();
  const [items, setItems] = useState<ChatAttachment[]>([]);
  const list = useRef<ChatAttachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const controllers = useRef(new Map<string, AbortController>());
  const [slots] = useState(() => limiter(2));

  const change = useCallback((next: (rows: ChatAttachment[]) => ChatAttachment[]) => {
    list.current = next(list.current);
    setItems(list.current);
  }, []);
  const update = useCallback((key: string, patch: Partial<ChatAttachment>) => change((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row))), [change]);

  useEffect(
    () => () => {
      for (const controller of controllers.current.values()) controller.abort();
      for (const item of list.current) revoke(item);
    },
    [],
  );

  const upload = useCallback(
    async (key: string, file: File) => {
      const controller = new AbortController();
      controllers.current.set(key, controller);
      try {
        const { file: saved } = await slots(() => {
          update(key, { state: "uploading", progress: 0, error: null });
          return filesApi.upload(file, { summarize: false, signal: controller.signal, onProgress: (progress) => update(key, { progress }) });
        }, controller.signal);
        void invalidateFileLists(client);
        if (!list.current.some((row) => row.key === key)) return;
        const twin = list.current.find((row) => row.key !== key && row.fileId === saved.id);
        if (twin) {
          change((rows) => rows.filter((row) => {
            if (row.key === key) revoke(row);
            return row.key !== key;
          }));
          setNotice(`${saved.filename} is already attached.`);
          return;
        }
        update(key, { state: "ready", progress: 1, fileId: saved.id, name: saved.filename, size: saved.byteSize, kind: saved.kind ?? fileFormat(saved.filename).kind });
        setAnnouncement(`${saved.filename} uploaded and attached.`);
      } catch (error) {
        if (controller.signal.aborted) return;
        const reason = isRequestCancelled(error) ? "The upload stopped before it finished." : error instanceof Error && error.message ? error.message : "The upload failed.";
        update(key, { state: "failed", error: reason });
        setAnnouncement(`Could not upload ${file.name}. ${reason}`);
      } finally {
        if (controllers.current.get(key) === controller) controllers.current.delete(key);
      }
    },
    [change, client, slots, update],
  );

  /** Files from this computer: dropped, pasted or picked. */
  const add = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      const usage = client.getQueryData<{ usage: FileUsage }>(FILE_QUERY.list(""))?.usage;
      const { accepted, refused } = checkUploads(files, usage);
      const room = Math.max(0, CHAT_FILES_MAX - list.current.length);
      const taken = accepted.slice(0, room);
      const said = [refusedNotice(refused), accepted.length > room ? tooManyFiles() : null].filter(Boolean);
      setNotice(said.length ? said.join(" ") : null);
      if (!taken.length) return;
      const added = taken.map((file) => ({
        key: `attachment-${++counter}`,
        name: file.name,
        size: file.size,
        kind: fileFormat(file.name).kind,
        state: "waiting" as const,
        progress: 0,
        fileId: null,
        error: null,
        preview: picture(file),
        local: file,
      }));
      change((rows) => [...rows, ...added]);
      setAnnouncement(added.length === 1 ? `Uploading ${added[0]!.name}.` : `Uploading ${added.length} files.`);
      for (const item of added) void upload(item.key, item.local);
    },
    [change, client, upload],
  );

  /** A file already in Files: referenced where it is, not uploaded again. */
  const addSaved = useCallback(
    (mention: PageMention, file?: Pick<FileRecord, "byteSize" | "kind">) => {
      if (list.current.some((row) => row.fileId === mention.id)) {
        setNotice(`${mention.label} is already attached.`);
        return;
      }
      if (list.current.length >= CHAT_FILES_MAX) {
        setNotice(tooManyFiles());
        return;
      }
      setNotice(null);
      change((rows) => [
        ...rows,
        {
          key: `attachment-${++counter}`,
          name: mention.label,
          size: file?.byteSize ?? null,
          kind: file?.kind ?? fileFormat(mention.label).kind,
          state: "ready",
          progress: 1,
          fileId: mention.id,
          error: null,
          preview: null,
          local: null,
        },
      ]);
      setAnnouncement(`${mention.label} attached.`);
    },
    [change],
  );

  /** Stops an upload. The server may have kept the file already; it is simply not attached. */
  const cancel = useCallback(
    (key: string) => {
      const item = list.current.find((row) => row.key === key);
      if (!item) return;
      controllers.current.get(key)?.abort();
      controllers.current.delete(key);
      revoke(item);
      change((rows) => rows.filter((row) => row.key !== key));
      setAnnouncement(`Upload of ${item.name} cancelled.`);
    },
    [change],
  );

  /** Takes the file off this message. It stays in Files. */
  const remove = useCallback(
    (key: string) => {
      const item = list.current.find((row) => row.key === key);
      if (!item) return;
      controllers.current.get(key)?.abort();
      controllers.current.delete(key);
      revoke(item);
      change((rows) => rows.filter((row) => row.key !== key));
      setNotice(null);
      setAnnouncement(`${item.name} removed from this message.`);
    },
    [change],
  );

  const retry = useCallback(
    (key: string) => {
      const item = list.current.find((row) => row.key === key);
      if (!item?.local || item.state !== "failed") return;
      update(key, { state: "waiting", progress: 0, error: null });
      setAnnouncement(`Uploading ${item.name} again.`);
      void upload(key, item.local);
    },
    [update, upload],
  );

  /**
   * The uploaded files, taken off the shelf for sending; with `only`, just those of them still there.
   * Failed ones stay so the person sees they did not go.
   */
  const take = useCallback(
    (only?: ChatAttachment[]): ChatAttachment[] => {
      const keys = only ? new Set(only.map((item) => item.key)) : null;
      const ready = list.current.filter((row) => row.state === "ready" && (!keys || keys.has(row.key)));
      if (ready.length) change((rows) => rows.filter((row) => !ready.includes(row)));
      setNotice(null);
      return ready;
    },
    [change],
  );

  /** Puts taken files back after a send that did not reach the assistant. */
  const restore = useCallback(
    (taken: ChatAttachment[]) => {
      if (!taken.length) return;
      change((rows) => {
        const back = taken.filter((item) => !rows.some((row) => row.key === item.key || (item.fileId && row.fileId === item.fileId)));
        for (const item of taken) if (!back.includes(item) && !rows.some((row) => row.key === item.key)) revoke(item);
        const merged = [...back, ...rows];
        for (const dropped of merged.slice(CHAT_FILES_MAX)) {
          controllers.current.get(dropped.key)?.abort();
          revoke(dropped);
        }
        return merged.slice(0, CHAT_FILES_MAX);
      });
    },
    [change],
  );

  /** Frees the pictures of files that were sent. */
  const release = useCallback((taken: ChatAttachment[]) => {
    for (const item of taken) if (!list.current.some((row) => row.key === item.key)) revoke(item);
  }, []);

  const uploading = items.filter((row) => row.state === "waiting" || row.state === "uploading").length;
  return { items, notice, setNotice, announcement, uploading, ready: items.filter((row) => row.state === "ready"), add, addSaved, cancel, remove, retry, take, restore, release };
}

export type ChatAttachments = ReturnType<typeof useChatAttachments>;

export function attachmentMentions(items: ChatAttachment[]): PageMention[] {
  return items.flatMap((item) => (item.state === "ready" && item.fileId ? [{ kind: "file" as const, id: item.fileId, label: item.name }] : []));
}

/** A picture in Files, fetched with the session cookie. Null until it loads, and when it cannot. */
export function useFileThumbnail(id: string | null, name: string): string | null {
  const format = fileFormat(name);
  const enabled = Boolean(id) && format.kind === "image" && format.preview;
  const bytes = useQuery({ queryKey: ["file-thumbnail", id], queryFn: () => filesApi.original(id!), enabled, staleTime: Number.POSITIVE_INFINITY, retry: false });
  return useBlobUrl(enabled ? bytes.data : undefined, format.mime);
}

function Thumbnail({ name, kind, src, size }: { name: string; kind: FileKind; src: string | null; size: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (src && !broken) return <img src={src} alt="" aria-hidden className="shrink-0 rounded-md object-cover" style={{ width: size, height: size }} onError={() => setBroken(true)} data-thumbnail={name} />;
  return <FileIcon kind={kind} size={size} />;
}

function SavedThumbnail({ id, name, kind, size }: { id: string | null; name: string; kind: FileKind; size: number }) {
  return <Thumbnail name={name} kind={kind} src={useFileThumbnail(id, name)} size={size} />;
}

function AttachmentChip({ item, attachments }: { item: ChatAttachment; attachments: ChatAttachments }) {
  const busy = item.state === "waiting" || item.state === "uploading";
  const percent = Math.round(item.progress * 100);
  const size = item.size === null ? null : formatBytes(item.size);
  const status = item.state === "waiting" ? "Waiting to upload" : item.state === "uploading" ? `Uploading ${percent}%` : null;
  return (
    <li className="assistant-attachment" data-state={item.state} title={item.error ? `${item.name}: ${item.error}` : item.name}>
      {item.preview ? <Thumbnail name={item.name} kind={item.kind} src={item.preview} size={30} /> : <SavedThumbnail id={item.fileId} name={item.name} kind={item.kind} size={30} />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-ink">{item.name}</span>
        <span className={cx("block text-[11px]", item.state === "failed" ? "text-danger" : "text-muted")}>
          {item.state === "failed" ? item.error ?? "The upload failed." : [size, status].filter(Boolean).join(" · ")}
        </span>
      </span>
      {item.state === "failed" && item.local ? (
        <button type="button" className="icon-btn" aria-label={`Retry uploading ${item.name}`} title="Retry" onClick={() => attachments.retry(item.key)}>
          <RotateCw size={13} />
        </button>
      ) : null}
      {busy ? (
        <button type="button" className="icon-btn" aria-label={`Cancel uploading ${item.name}`} title="Cancel upload" onClick={() => attachments.cancel(item.key)}>
          <X size={13} />
        </button>
      ) : (
        <button type="button" className="icon-btn" aria-label={`Remove ${item.name} from this message`} title="Remove from this message (it stays in Files)" onClick={() => attachments.remove(item.key)}>
          <X size={13} />
        </button>
      )}
      {busy ? <span className="assistant-attachment-progress" role="progressbar" aria-label={`Uploading ${item.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} style={{ width: `${percent}%` }} /> : null}
    </li>
  );
}

/** The files above the message box, and what happened to the last one added. `hintId` names the line Send points to while files upload. */
export function AttachmentShelf({ attachments, hintId }: { attachments: ChatAttachments; hintId?: string }) {
  const { items, notice, uploading } = attachments;
  return (
    <>
      {items.length || notice ? (
        <div className="assistant-attachments">
          {items.length ? (
            <ul aria-label={`Attached files (${items.length} of ${CHAT_FILES_MAX})`} className="flex flex-wrap gap-1.5">
              {items.map((item) => (
                <AttachmentChip key={item.key} item={item} attachments={attachments} />
              ))}
            </ul>
          ) : null}
          {uploading ? (
            <p id={hintId} className="assistant-attachment-hint">
              {uploading === 1 ? "Uploading 1 file. You can send when it finishes." : `Uploading ${uploading} files. You can send when they finish.`}
            </p>
          ) : null}
          {notice ? (
            <p className="assistant-attachment-notice" data-attachment-notice>
              <span className="min-w-0 flex-1">{notice}</span>
              <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => attachments.setNotice(null)}>
                <X size={12} />
              </button>
            </p>
          ) : null}
        </div>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {notice ?? attachments.announcement}
      </span>
    </>
  );
}

/** The paperclip: upload from this computer, or pick a file already in Files. `onAttached` runs after either, to put focus back in the box. */
export function AttachMenu({ attachments, onAttached }: { attachments: ChatAttachments; onAttached?: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);
  return (
    <>
      <Popover
        width={240}
        trigger={(open, toggle) => (
          <button type="button" className="assistant-attach icon-btn" aria-label="Attach files" title="Attach files" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
            <Paperclip size={15} />
          </button>
        )}
      >
        {(close) => (
          <div
            role="menu"
            aria-label="Attach files"
            className="space-y-0.5"
            onKeyDown={(event) => {
              const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
              const at = items.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === "ArrowDown" ? (at + 1) % items.length : event.key === "ArrowUp" ? (at + items.length - 1) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
              if (next < 0) return;
              event.preventDefault();
              items[next]?.focus();
            }}
          >
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] text-ink hover:bg-hover focus-visible:bg-hover"
              onClick={() => {
                close();
                input.current?.click();
              }}
            >
              <Monitor size={14} aria-hidden /> Upload from this computer
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] text-ink hover:bg-hover focus-visible:bg-hover"
              onClick={() => {
                close();
                setPicking(true);
              }}
            >
              <FolderOpen size={14} aria-hidden /> Choose from Files
            </button>
          </div>
        )}
      </Popover>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        aria-hidden
        data-attach-input
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          attachments.add(files);
          if (files.length) onAttached?.();
        }}
      />
      <AddFileToMessage
        open={picking}
        onOpenChange={setPicking}
        attached={attachments.items.flatMap((item) => (item.fileId ? [item.fileId] : []))}
        onInsert={(mention, file) => {
          attachments.addSaved(mention, file);
          onAttached?.();
        }}
      />
    </>
  );
}

function SentFile({ mention }: { mention: PageMention }) {
  const kind = fileFormat(mention.label).kind;
  const href = inItemView() ? undefined : mentionHref(mention);
  const body = (
    <>
      <SavedThumbnail id={mention.id} name={mention.label} kind={kind} size={kind === "image" ? 40 : 22} />
      <span className="min-w-0 truncate">{mention.label}</span>
    </>
  );
  return (
    <li>
      {href ? (
        <Link href={href} className="assistant-sent-file" title={`Open ${mention.label} in Files`} data-id={mention.id}>
          {body}
        </Link>
      ) : (
        <span className="assistant-sent-file" title={mention.label} data-id={mention.id}>
          {body}
        </span>
      )}
    </li>
  );
}

/** Files a sent message carried that its text does not already show as `@file:` mentions. */
export function MessageFiles({ content, mentions }: { content: string; mentions?: PageMention[] | null }) {
  const files = (mentions ?? []).filter((mention) => mention.kind === "file" && mention.id);
  if (!files.length) return null;
  const inline = new Set(mentionRanges(content, mentions ?? []).flatMap((range) => (range.mention ? [mentionKey(range.mention)] : [])));
  const shown = withAttachedFiles([], files).filter((mention) => !inline.has(mentionKey(mention)));
  if (!shown.length) return null;
  return (
    <ul className="assistant-message-files" aria-label="Attached files">
      {shown.map((mention) => (
        <SentFile key={mention.id} mention={mention} />
      ))}
    </ul>
  );
}
