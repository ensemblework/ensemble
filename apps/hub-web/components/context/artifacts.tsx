"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, UploadCloud } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { fileFormat } from "@ensemble/shared-types";
import { api } from "@/lib/api";
import { FILE_QUERY, filesApi, formatBytes } from "@/lib/api-files";
import { FILE_ACCEPT } from "@/lib/files/formats";
import { plural, relative } from "@/lib/format";
import { FileIcon } from "../files/file-icon";
import { Uploads, UsageMeter } from "../files/files-screen";
import { useFileUploads } from "../files/use-uploads";
import { Empty, Spinner, cx } from "../ui";

const RECENT = 8;

export function ArtifactsTab() {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const uploads = useFileUploads();
  const files = useQuery({ queryKey: FILE_QUERY.list(""), queryFn: () => filesApi.list("") });
  const artifacts = useQuery({ queryKey: ["artifacts", "sync"], queryFn: () => api.artifacts({}) });
  const list = files.data?.files ?? [];

  return (
    <div className="space-y-6">
      <section
        onDragOver={(event) => {
          if (!Array.from(event.dataTransfer.types).includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          setDragging(false);
          uploads.start(Array.from(event.dataTransfer.files));
        }}
        className={cx("tile rounded-lg bg-panel p-5", dragging && "border-dashed border-accent bg-accent-soft")}
        aria-label="Files"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-[18px] font-semibold">Files</h3>
            <p className="mt-0.5 max-w-xl text-[13px] text-muted">
              Reference files live in Files, where you can preview them and attach them to pages. Ensemble and your agents can read their text. Drop files here to add them.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" className="btn" onClick={() => input.current?.click()}>
              <UploadCloud size={13} /> Upload
            </button>
            <Link href="/files" className="btn-primary">
              Open Files <ArrowRight size={13} />
            </Link>
          </div>
          <input
            ref={input}
            type="file"
            multiple
            accept={FILE_ACCEPT}
            className="hidden"
            onChange={(event) => {
              uploads.start(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
        </div>
        <div className="mt-4">
          {files.data?.usage ? <UsageMeter usage={files.data.usage} /> : null}
          <Uploads items={uploads.items} onDismiss={uploads.dismiss} />
          {files.isPending ? (
            <Spinner />
          ) : files.error ? (
            <p className="text-[13px] text-danger">{(files.error as Error).message}</p>
          ) : !list.length ? (
            <p className="text-[13px] text-muted">No files yet.</p>
          ) : (
            <ul className="grid gap-1 sm:grid-cols-2">
              {list.slice(0, RECENT).map((file) => (
                <li key={file.id}>
                  <Link href={`/files/${file.id}`} prefetch={false} className="row-tile flex items-center gap-2.5 rounded-lg px-2 py-1.5">
                    <FileIcon kind={file.kind ?? fileFormat(file.filename).kind} size={26} />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium">{file.filename}</span>
                      <span className="block truncate text-[12px] text-muted">
                        {formatBytes(file.byteSize)} · {relative(file.createdAt)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {list.length > RECENT ? (
            <Link href="/files" className="mt-2 inline-block text-[12.5px] text-accent hover:underline">
              See all {plural(list.length, "file")}
            </Link>
          ) : null}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-[15px] font-semibold">Sync</h3>
        {(artifacts.data?.sync ?? []).length === 0 ? (
          <Empty>No source has synced yet.</Empty>
        ) : (
          <div className="divide-y divide-[var(--line)] rounded-md border border-line text-[13px]">
            {artifacts.data!.sync.map((row) => (
              <div key={row.connector} className="flex items-center justify-between px-3 py-2">
                <span className="font-medium">{row.connector}</span>
                <span className={row.lastError ? "text-[#ffb4ae]" : "text-muted"}>
                  {row.lastError ?? `${plural(row.itemCount, "item")} · ${relative(row.lastSyncAt)}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
