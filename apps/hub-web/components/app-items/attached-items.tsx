"use client";
import { BrandMorph } from "@/components/motion/brand-morph";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { APP_ITEM_KIND_LABEL, type AttachedAppItem } from "@ensemble/shared-types";
import { APP_ITEM_QUERY, appItemsApi, type AppItemOwner } from "@/lib/api-app-items";
import { relative } from "@/lib/format";
import { BrandLogo } from "../connectors/brand-logo";
import { useToast } from "../toast";
import { cx } from "../ui";
import { AppItemPicker } from "./app-item-picker";
import { sourceInfo, useAppItemSources } from "./use-app-items";

/**
 * "From your apps" on a task or project: pages, issues and files attached as
 * context. Their text is kept so the assistant and agents can read it.
 */
export function AttachedItems({ taskId, projectId, className }: { taskId?: string; projectId?: string; className?: string }) {
  const owner: AppItemOwner | null = taskId ? { taskId } : projectId ? { projectId } : null;
  const { sources, allowed } = useAppItemSources();
  const client = useQueryClient();
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const attached = useQuery({
    queryKey: owner ? APP_ITEM_QUERY.attached(owner) : ["app-items-attached", "none"],
    queryFn: () => appItemsApi.attached(owner!),
    enabled: Boolean(owner) && allowed,
    retry: false,
  });
  const changed = () => {
    if (!owner) return;
    void client.invalidateQueries({ queryKey: APP_ITEM_QUERY.attached(owner) });
    if (taskId) void client.invalidateQueries({ queryKey: APP_ITEM_QUERY.updateTarget(taskId) });
  };
  const refresh = useMutation({
    mutationFn: (item: AttachedAppItem) => appItemsApi.refresh(item.artifactId),
    onSuccess: ({ item }) => {
      toast(`Refreshed “${item.title}”.`);
      changed();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const remove = useMutation({
    mutationFn: (item: AttachedAppItem) => appItemsApi.detach(item.artifactId, owner!),
    onSuccess: changed,
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });

  if (!owner || !allowed) return null;
  const items = attached.data?.items ?? [];
  const what = taskId ? "task" : "project";
  const add = (
    <button type="button" className="flex items-center gap-1 text-[12.5px] text-muted hover:text-ink" onClick={() => setPicking(true)}>
      <Plus size={13} aria-hidden /> Add from apps…
    </button>
  );

  return (
    <section className={cx("text-[13px]", className)} aria-label="From your apps" data-testid="attached-items">
      {items.length ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[12.5px] font-medium text-muted">From your apps</h2>
            {add}
          </div>
          <p className="text-[12px] text-faint">The assistant and agents working on this {what} read these.</p>
          <ul className="mt-1.5 divide-y divide-[var(--line)] rounded-lg border border-line">
            {items.map((item) => {
              const info = sourceInfo(sources, item.source);
              const refreshing = refresh.isPending && refresh.variables?.artifactId === item.artifactId;
              return (
                <li key={item.artifactId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-attached={item.artifactId}>
                  <div className="flex min-w-0 flex-1 basis-[220px] items-start gap-2.5">
                    <BrandLogo id={info.logo} name={info.name} size={20} className="mt-0.5" />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{item.title || "Untitled"}</div>
                      <div className="truncate text-[12px] text-muted">
                        {[APP_ITEM_KIND_LABEL[item.kind], item.subtitle, `added ${relative(item.attachedAt)}`, `${item.chars.toLocaleString()} characters kept`]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-0.5">
                    {item.url ? (
                      <a href={item.url} target="_blank" rel="noreferrer" className="btn-ghost text-[12px]" aria-label={`Open ${item.title} in ${info.name}`}>
                        Open ↗
                      </a>
                    ) : null}
                    <button
                      type="button"
                      className="icon-btn"
                      title={`Read it again from ${info.name}`}
                      aria-label={`Refresh ${item.title}`}
                      disabled={refreshing}
                      onClick={() => refresh.mutate(item)}
                    >
                      {refreshing ? <BrandMorph size={14} kind="beacon" state="loop" /> : <RefreshCw size={13} />}
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Remove"
                      aria-label={`Remove ${item.title}`}
                      disabled={remove.isPending && remove.variables?.artifactId === item.artifactId}
                      onClick={() => remove.mutate(item)}
                    >
                      <X size={13} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        add
      )}
      {attached.error ? <p className="mt-1 text-[12px] text-muted">Could not load what is attached: {(attached.error as Error).message}</p> : null}
      <AppItemPicker
        open={picking}
        onClose={() => setPicking(false)}
        description={`Attached items are read now and kept as text with this ${what}.`}
        actionLabel="Attach"
        doneLabel="Attached"
        onPick={async (item) => {
          await appItemsApi.attach(item, owner);
          changed();
        }}
      />
    </section>
  );
}
