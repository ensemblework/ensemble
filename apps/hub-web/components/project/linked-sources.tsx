"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, X } from "lucide-react";
import { MenuItem, Popover, Tag } from "@/components/ui";
import { useToast } from "@/components/toast";
import { connectedApi, LINK_SOURCE_LABEL, type SourceContainer } from "@/lib/api-connected";

const sourceLabel = (source: string) => LINK_SOURCE_LABEL[source] ?? source;

/**
 * "Linked sources" on a project page: Slack channels, repos, Linear projects,
 * Notion databases… whose new items land in this project.
 */
export function LinkedSources({ projectId, projectName }: { projectId: string; projectName: string }) {
  const client = useQueryClient();
  const toast = useToast();
  const links = useQuery({ queryKey: ["project-links", projectId], queryFn: () => connectedApi.projectLinks(projectId) });
  const containers = useQuery({ queryKey: ["source-containers"], queryFn: () => connectedApi.sourceContainers(), staleTime: 60_000 });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["project-links"] });
    void client.invalidateQueries({ queryKey: ["source-containers"] });
    void client.invalidateQueries({ queryKey: ["project", projectId] });
  };
  const add = useMutation({
    mutationFn: (container: SourceContainer) =>
      connectedApi.linkContainer({ projectId, source: container.source, containerId: container.id, containerName: container.name }),
    onSuccess: (result) => {
      const moved = result.applied.artifacts + result.applied.tasks;
      toast(`${result.link.containerName} now goes to ${projectName}${moved ? ` (${moved} earlier item${moved === 1 ? "" : "s"} moved here)` : ""}.`);
      refresh();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => connectedApi.unlinkContainer(id),
    onSuccess: refresh,
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });

  const rows = links.data?.links ?? [];
  const options = (containers.data?.containers ?? []).filter((row) => row.projectId !== projectId);

  return (
    <div className="flex min-h-[32px] items-start gap-2 text-[13.5px]" data-testid="linked-sources">
      <span className="flex w-[140px] shrink-0 items-center gap-2 pt-0.5 text-muted">
        <Link2 size={14} /> Linked sources
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {rows.map((link) => (
          <Tag key={link.id} tone="purple" className="inline-flex items-center gap-1">
            <span className="opacity-70">{sourceLabel(link.source)}</span> {link.containerName}
            <button type="button" aria-label={`Unlink ${link.containerName}`} className="ml-0.5 rounded hover:text-ink" onClick={() => remove.mutate(link.id)}>
              <X size={11} />
            </button>
          </Tag>
        ))}
        <Popover
          width={320}
          trigger={(_open, toggle) => (
            <button type="button" onClick={toggle} className="row-tile -mx-1.5 rounded px-1.5 py-0.5 text-faint hover:text-ink">
              {rows.length ? "Add" : "Link a channel, repo or board"}
            </button>
          )}
        >
          {(close) =>
            options.length ? (
              options.slice(0, 60).map((row) => (
                <MenuItem
                  key={`${row.source}:${row.id}`}
                  hint={row.projectName ? `in ${row.projectName}` : row.count ? `${row.count} item${row.count === 1 ? "" : "s"}` : undefined}
                  onClick={() => (close(), add.mutate(row))}
                >
                  <span className="text-muted">{sourceLabel(row.source)}</span> {row.name}
                </MenuItem>
              ))
            ) : (
              <p className="px-2 py-1.5 text-[12.5px] text-muted">Nothing to link yet. Channels, repos and boards show up here after a sync or an import.</p>
            )
          }
        </Popover>
      </div>
    </div>
  );
}
