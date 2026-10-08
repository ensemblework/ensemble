"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, Plus, Search, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { api, type PersonRecord } from "@/lib/api";
import { plural, shortDate } from "@/lib/format";
import { useToast } from "../toast";
import { Dialog, Empty, Field, InlineEdit, Spinner } from "../ui";

function PersonCard({ person }: { person: PersonRecord }) {
  const client = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: (data: Record<string, unknown>) => api.patchPerson(person.id, data),
    onSuccess: () => client.invalidateQueries({ queryKey: ["people"] }),
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const remove = useMutation({
    mutationFn: () => api.deletePerson(person.id),
    onSuccess: () => {
      toast(`Removed ${person.name}. They will not come back on the next sync.`);
      void client.invalidateQueries({ queryKey: ["people"] });
    },
  });
  return (
    <div className="tile lift group relative flex flex-col rounded-xl bg-panel p-4 text-[13px]">
      {person.derived ? null : (
        <button
          type="button"
          className="icon-btn absolute right-2 top-2 h-6 w-6 opacity-0 group-hover:opacity-100"
          title="Remove person"
          onClick={() => remove.mutate()}
        >
          <Trash2 size={13} />
        </button>
      )}
      <div className="flex items-start gap-2.5 pr-6">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold leading-5">{person.name}</div>
          <div className="truncate text-[12.5px] text-muted">{person.email ?? "No email"}</div>
        </div>
      </div>
      <div className="mt-3 flex min-w-0 items-center gap-1 text-[13px]">
        {person.derived ? (
          <span className="truncate text-muted">{person.role ?? "Assignee"}</span>
        ) : (
          <>
            <InlineEdit className="min-w-0 truncate" value={person.role ?? ""} placeholder="Add a role" onSave={(role) => save.mutate({ role: role || null })} />
            <span className="shrink-0 text-faint" aria-hidden>·</span>
            <InlineEdit className="min-w-0 truncate" value={person.team ?? ""} placeholder="Add a team" onSave={(team) => save.mutate({ team: team || null })} />
          </>
        )}
      </div>
      <div className="mt-2 truncate text-[12px] text-muted">
        {person.openTasks ? `${person.openTasks} open` : "No open tasks"}
        {person.recentTitle ? ` · ${person.recentTitle}` : ""}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {person.projects.length ? (
          person.projects.map((project) => (
            <span key={project.id} className="chip" style={{ ["--chip" as string]: "var(--kind-project)" }}>
              {project.name}
            </span>
          ))
        ) : (
          <span className="text-[12px] text-faint">No project yet</span>
        )}
      </div>
      <div className="mt-3 flex items-center gap-1 text-[11.5px] text-faint">
        <Clock3 size={12} />
        {person.lastInteraction ? shortDate(person.lastInteraction) : "No interaction yet"}
      </div>
    </div>
  );
}

export function PeopleTab({ initialSearch, who = "" }: { initialSearch: string; who?: string }) {
  const client = useQueryClient();
  const people = useQuery({ queryKey: ["people"], queryFn: api.people });
  const [search, setSearch] = useState(initialSearch);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const toast = useToast();
  const create = useMutation({
    mutationFn: () => api.createPerson({ name: name.trim(), email: email.trim() || undefined, role: role.trim() || undefined }),
    onSuccess: () => {
      setAdding(false);
      toast(`Added ${name.trim()}.`, { tone: "ok" });
      setName("");
      setEmail("");
      setRole("");
      void client.invalidateQueries({ queryKey: ["people"] });
      void client.invalidateQueries({ queryKey: ["entities"] });
      void client.invalidateQueries({ queryKey: ["desk-live"] });
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
  const wanted = who ? new Set(who.split(",").filter(Boolean)) : null;
  const list = (people.data?.people ?? []).filter((person) => {
    if (wanted && !wanted.has(person.id) && !wanted.has(person.name)) return false;
    return `${person.name} ${person.email ?? ""} ${person.team ?? ""}`.toLowerCase().includes(search.toLowerCase());
  });
  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <span className="text-[13px] font-semibold">{plural(list.length, "person", "people")}</span>
        <div className="flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1">
          <Search size={13} className="text-faint" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter people…"
            className="search-line w-48 bg-transparent text-[13px] outline-none placeholder:text-faint"
          />
        </div>
        <div className="flex-1" />
        <button type="button" className="btn" onClick={() => setAdding(true)}>
          <Plus size={13} /> Add person
        </button>
      </div>
      {people.isLoading ? (
        <Spinner />
      ) : list.length === 0 ? (
        wanted ? (
          <Empty>No one on today's work.</Empty>
        ) : (
          <div className="empty-state flex flex-col items-start gap-3" data-people-empty>
            <span className="flex items-center gap-2 text-[14px] font-medium text-ink"><Users size={15} /> Add the people you work with</span>
            <span>Teammates, clients, advisors, or classmates. Mention them on pages and tasks, and they appear on the graph. Connected mail, chat, and reviews add more as they sync.</span>
            <button type="button" className="btn-primary" onClick={() => setAdding(true)}>Add a person</button>
          </div>
        )
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(270px,1fr))] gap-3">
          {list.map((person) => (
            <PersonCard key={person.id} person={person} />
          ))}
        </div>
      )}
      <Dialog open={adding} onClose={() => setAdding(false)} title="Add a person">
        <div className="space-y-3">
          <Field label="Name">
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} className="field w-full" />
          </Field>
          <Field label="Email (optional)">
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="field w-full" />
          </Field>
          <Field label="Role (optional)">
            <input value={role} onChange={(event) => setRole(event.target.value)} placeholder="e.g. Advisor, client, teammate" className="field w-full" />
          </Field>
          <div className="flex justify-end">
            <button type="button" className="btn-primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? "Adding…" : "Add person"}
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
