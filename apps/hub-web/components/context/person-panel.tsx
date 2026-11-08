"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { api } from "@/lib/api";
import { shortDate } from "@/lib/format";
import { useToast } from "../toast";
import { InlineEdit, Spinner } from "../ui";
import { LoadError } from "../load-error";
import { RelationGroups, contextItemKey, useContextItem, useOpenCard } from "./item-relations";

export const personRef = (id: string) => `ensemble://person/${id}`;

/** Someone in Context › People with everything that links to them: projects and roles, open work, what you wait on, meetings. */
export function PersonPanel({ id }: { id: string }) {
  const ref = personRef(id);
  const item = useContextItem(ref);
  const openCard = useOpenCard();
  const client = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: (data: Record<string, unknown>) => api.patchPerson(id, data),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: contextItemKey(ref) });
      void client.invalidateQueries({ queryKey: ["people"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  if (item.isPending) return <div className="flex justify-center py-8"><Spinner /></div>;
  if (item.isError || !item.data) return <LoadError error={item.error} onRetry={() => void item.refetch()} what="this person" />;
  const facts = item.data.item.facts as { email?: string | null; role?: string | null; team?: string | null; relationship?: string | null; lastInteraction?: string | null };
  return (
    <div className="flex flex-col gap-5 px-1 pb-6" data-person-panel={id}>
      <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-4 gap-y-1.5 text-[13px]">
        <dt className="text-muted">Role</dt>
        <dd className="min-w-0"><InlineEdit className="min-w-0 truncate" value={facts.role ?? ""} placeholder="Add a role" onSave={(role) => save.mutate({ role: role || null })} /></dd>
        <dt className="text-muted">Team</dt>
        <dd className="min-w-0"><InlineEdit className="min-w-0 truncate" value={facts.team ?? ""} placeholder="Add a team" onSave={(team) => save.mutate({ team: team || null })} /></dd>
        <dt className="text-muted" title="How they relate to you. Agents read this when they work on tasks with them.">To you</dt>
        <dd className="min-w-0"><InlineEdit className="min-w-0 truncate" value={facts.relationship ?? ""} placeholder="My manager, a client, reports to me…" onSave={(relationship) => save.mutate({ relationship: relationship || null })} /></dd>
        {facts.email ? (
          <>
            <dt className="text-muted">Email</dt>
            <dd className="min-w-0 truncate"><a className="inline-flex items-center gap-1 hover:underline" href={`mailto:${facts.email}`}><Mail size={12} aria-hidden />{facts.email}</a></dd>
          </>
        ) : null}
        {facts.lastInteraction ? (
          <>
            <dt className="text-muted">Last seen</dt>
            <dd>{shortDate(facts.lastInteraction)}</dd>
          </>
        ) : null}
      </dl>
      <RelationGroups data={item.data} onOpen={openCard} empty="No projects, tasks or meetings with them yet." />
    </div>
  );
}
