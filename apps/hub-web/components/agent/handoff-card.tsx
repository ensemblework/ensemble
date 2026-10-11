"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "@/lib/api";
import { useModuleOn } from "@/lib/use-module";
import { Tag } from "../ui";

/** Tasks opened in an agent's own app (Claude, Codex, Cursor, VS Code), on the task page. */
export function TaskHandoffs({ taskId }: { taskId: string }) {
  const workspaceOn = useModuleOn("workspace");
  const client = useQueryClient();
  const handoffs = useQuery({ queryKey: ["task-handoffs", taskId], queryFn: () => api.handoffs(taskId), enabled: workspaceOn, refetchInterval: 15_000 });
  const close = useMutation({ mutationFn: api.closeHandoff, onSuccess: () => client.invalidateQueries({ queryKey: ["task-handoffs", taskId] }) });
  const rows = (handoffs.data?.handoffs ?? []).filter((row) => row.status !== "closed").slice(0, 3);
  if (!rows.length) return null;
  return (
    <div className="mt-4 space-y-2" data-testid="task-handoffs">
      {rows.map((row) => (
        <div key={row.id} className="rounded-lg border border-line bg-raised px-3 py-2.5 text-[12.5px]">
          <div className="flex flex-wrap items-center gap-2">
            <Tag tone={row.status === "finished" ? "green" : "blue"}>{row.status === "finished" ? `${row.appName} finished a turn` : `In ${row.appName}`}</Tag>
            <span className="truncate text-muted">{row.folder}</span>
            <div className="flex-1" />
            <button type="button" className="btn-ghost py-0 text-[12px]" disabled={close.isPending} onClick={() => close.mutate(row.id)}>
              Done with it
            </button>
          </div>
          <div className="mt-1.5 text-muted">
            {!row.linked
              ? row.app.endsWith("-cli")
                ? `Starting ${row.appName} in a terminal.`
                : `Waiting for you to press Send in ${row.appName}.`
              : row.status === "finished"
                ? row.summary ?? "Its last turn ended. Continue there, or mark it done here."
                : (
                    <>
                      Working. Its permission prompts and questions come to{" "}
                      <Link href="/needs-me" className="text-accent hover:underline">
                        Needs me
                      </Link>{" "}
                      as well as {row.appName}.
                    </>
                  )}
          </div>
        </div>
      ))}
    </div>
  );
}
