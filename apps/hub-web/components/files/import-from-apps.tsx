"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, FolderOpen, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { AppItem, FileImportSource } from "@ensemble/shared-types";
import { FILE_QUERY, filesApi } from "@/lib/api-files";
import { emitToast } from "@/lib/toast-bus";
import { AppItemPicker, problemText } from "../app-items/app-item-picker";
import { BrandLogo } from "../connectors/brand-logo";
import { Dialog, SkeletonRows, Spinner, Tag, cx } from "../ui";
import { PICKER_UNAVAILABLE, pickFromGoogleDrive } from "./google-picker";
import { invalidateFileLists } from "./use-file";

const STATE: Record<FileImportSource["state"], { label: string; tone: "green" | "orange" | "gray" } | null> = {
  ready: null,
  needs_permission: { label: "Needs permission", tone: "orange" },
  not_connected: { label: "Not connected", tone: "gray" },
  not_set_up: { label: "Not set up yet", tone: "gray" },
};

function Guidance({ source, note, onNavigate }: { source: FileImportSource; note?: string; onNavigate: () => void }) {
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-line bg-panel px-3 py-2.5" data-import-guidance={source.id}>
      {note ? <p className="text-ink">{note}</p> : null}
      {source.steps?.length ? (
        <ol className="list-decimal space-y-1 pl-5 text-muted">
          {source.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      ) : null}
      {source.action ? (
        source.action.href.startsWith("/") ? (
          <Link href={source.action.href} className="btn inline-flex" onClick={onNavigate}>
            {source.action.label} <ArrowRight size={13} aria-hidden />
          </Link>
        ) : (
          <a href={source.action.href} target="_blank" rel="noreferrer" className="btn inline-flex">
            {source.action.label} <ArrowRight size={13} aria-hidden />
          </a>
        )
      ) : null}
    </div>
  );
}

function SourceRow({ source, onChoose, onClose }: { source: FileImportSource; onChoose: () => void; onClose: () => void }) {
  const client = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [needsDrive, setNeedsDrive] = useState(false);
  const state = STATE[source.state];
  const ready = source.state === "ready";

  const openPicker = async () => {
    setPicking(true);
    try {
      const config = await filesApi.googlePicker();
      if (!config.accessToken) {
        setNeedsDrive(true);
        return;
      }
      // The dialog makes the rest of the page inert, Google's picker included, so it closes first.
      onClose();
      const ids = await pickFromGoogleDrive({ ...config, accessToken: config.accessToken });
      if (!ids.length) return;
      emitToast(ids.length === 1 ? "Adding the file from Google Drive…" : `Adding ${ids.length} files from Google Drive…`);
      let added = 0;
      for (const id of ids) {
        try {
          await filesApi.importFromApp({ source: "google_workspace", kind: "file", id });
          added += 1;
        } catch (error) {
          emitToast(problemText(error), { tone: "error" });
        }
      }
      await invalidateFileLists(client);
      if (added) emitToast(added === 1 ? "Added 1 file from Google Drive." : `Added ${added} files from Google Drive.`, { tone: "ok" });
    } catch (error) {
      emitToast(error instanceof Error && error.message ? error.message : PICKER_UNAVAILABLE, { tone: "error" });
    } finally {
      setPicking(false);
    }
  };

  return (
    <li className="py-3" data-import-source={source.id} data-state={source.state}>
      <div className="flex flex-wrap items-start gap-3">
        <BrandLogo id={source.logo} name={source.name} size={30} decorative />
        <div className="min-w-0 flex-[1_1_14rem]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{source.name}</span>
            {state ? <Tag tone={state.tone}>{state.label}</Tag> : null}
          </div>
          <p className="mt-0.5 text-muted">{source.message}</p>
        </div>
        {ready ? (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {source.picker ? (
              <button type="button" className="btn" disabled={picking} onClick={() => void openPicker()}>
                {picking ? <Spinner size={12} /> : <FolderOpen size={13} aria-hidden />} Pick from Google Drive
              </button>
            ) : null}
            <button type="button" className={source.picker ? "btn-ghost" : "btn"} onClick={onChoose}>
              <Search size={13} aria-hidden /> {source.kind === "attachment" ? "Find attachments" : source.picker ? "Search Drive" : "Choose files"}
            </button>
          </div>
        ) : null}
      </div>
      {!ready ? <Guidance source={source} onNavigate={onClose} /> : null}
      {ready && needsDrive ? <Guidance source={source} onNavigate={onClose} note="Google Drive needs your permission before its picker can open. Approve Drive access, then try again." /> : null}
    </li>
  );
}

/** Lists the apps files can come from, with what each needs, and opens the right picker. */
export function ImportFromApps({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const [choosing, setChoosing] = useState<FileImportSource | null>(null);
  const sources = useQuery({ queryKey: FILE_QUERY.sources, queryFn: filesApi.importSources, enabled: open, staleTime: 30_000, retry: false });

  const add = async (item: AppItem) => {
    const { file } = await filesApi.importFromApp({ source: item.source, kind: item.kind, id: item.id });
    void invalidateFileLists(client);
    emitToast(`Added ${file.filename} to Files.`, { tone: "ok" });
  };

  const list = sources.data?.sources ?? [];
  return (
    <>
      <Dialog open={open && !choosing} onClose={onClose} title="Add from your apps" width={620}>
        <div className="text-[13px]" data-testid="file-import-sources">
          <p className="text-muted">Bring a copy of a file into Ensemble. The original stays where it is.</p>
          {sources.isPending ? (
            <SkeletonRows count={4} rowClassName="h-12" className="mt-3 space-y-2" />
          ) : sources.error ? (
            <p role="alert" className="mt-3 text-danger">
              {problemText(sources.error)}
            </p>
          ) : !list.length ? (
            <p className="mt-3 text-muted">No apps can send files here yet.</p>
          ) : (
            <ul className={cx("mt-1 divide-y divide-[var(--line)]")}>
              {list.map((source) => (
                <SourceRow key={source.id} source={source} onChoose={() => setChoosing(source)} onClose={onClose} />
              ))}
            </ul>
          )}
        </div>
      </Dialog>
      <AppItemPicker
        open={open && Boolean(choosing)}
        onClose={() => setChoosing(null)}
        title={choosing ? `Add from ${choosing.name}` : "Add from your apps"}
        description={choosing?.kind === "attachment" ? "Search your mail for the attachment, by sender, subject or file name." : undefined}
        sources={choosing ? [choosing.itemSource] : undefined}
        kinds={choosing ? [choosing.kind] : undefined}
        actionLabel="Add to Files"
        doneLabel="Added"
        onPick={add}
      />
    </>
  );
}
