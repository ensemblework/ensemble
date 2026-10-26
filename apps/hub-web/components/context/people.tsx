"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, Plus, Search, Trash2, Users } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiError, api, type PersonRecord } from "@/lib/api";
import { plural, shortDate } from "@/lib/format";
import { useToast } from "../toast";
import { Dialog, Empty, Field, InlineEdit, Spinner } from "../ui";
import { AddPeopleFromApps } from "../app-items/people-from-apps";
import { LoadError } from "../load-error";
import { emailProblem, findSamePerson } from "./person-match";

function PersonCard({ person, focused = false }: { person: PersonRecord; focused?: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) card.current?.scrollIntoView?.({ block: "nearest" });
  }, [focused]);
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
    <div
      ref={card}
      data-person-card={person.id}
      className={`tile lift group relative flex flex-col rounded-xl bg-panel p-4 text-[13px]${focused ? " ring-2 ring-accent" : ""}`}
    >
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
          <div className="truncate text-[15px] font-semibold leading-5" title={person.name}>{person.name}</div>
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
  const [emailError, setEmailError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ message: string; person: PersonRecord | null } | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const toast = useToast();
  const all = people.data?.people ?? [];
  const reset = () => {
    setName("");
    setEmail("");
    setRole("");
    setEmailError(null);
    setDuplicate(null);
  };
  const close = () => {
    setAdding(false);
    reset();
  };
  const create = useMutation({
    mutationFn: () => api.createPerson({ name: name.trim(), email: email.trim() || undefined, role: role.trim() || undefined }),
    onSuccess: () => {
      toast(`Added ${name.trim()}.`, { tone: "ok" });
      close();
      void client.invalidateQueries({ queryKey: ["people"] });
      void client.invalidateQueries({ queryKey: ["entities"] });
      void client.invalidateQueries({ queryKey: ["desk-live"] });
    },
    onError: async (error: Error) => {
      if (error instanceof ApiError && error.code === "person_exists") {
        const fresh = await client.fetchQuery({ queryKey: ["people"], queryFn: api.people, staleTime: 0 }).catch(() => null);
        setDuplicate({ message: error.message, person: fresh ? findSamePerson(fresh.people, { name, email }) : null });
        return;
      }
      if (error instanceof ApiError && error.status === 400 && /email/i.test(error.message)) {
        setEmailError(emailProblem(email) ?? "That email address is not valid.");
        emailRef.current?.focus();
        return;
      }
      toast(error.message, { tone: "error" });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || create.isPending) return;
    const problem = emailProblem(email);
    setEmailError(problem);
    if (problem) {
      emailRef.current?.focus();
      return;
    }
    const same = findSamePerson(all, { name, email });
    if (same) {
      setDuplicate({ message: `${same.name} is already in your people.`, person: same });
      return;
    }
    create.mutate();
  };
  const showPerson = (person: PersonRecord) => {
    close();
    setSearch(person.email ?? person.name);
    setFocusId(person.id);
  };
  const wanted = who ? new Set(who.split(",").filter(Boolean)) : null;
  const list = all.filter((person) => {
    if (wanted && !wanted.has(person.id) && !wanted.has(person.name)) return false;
    return `${person.name} ${person.email ?? ""} ${person.team ?? ""}`.toLowerCase().includes(search.toLowerCase());
  });
  const emailErrorId = `${formId}-email-error`;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="text-[13px] font-semibold">{plural(list.length, "person", "people")}</span>
        <div className="flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1">
          <Search size={13} className="text-faint" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter people…"
            aria-label="Filter people"
            className="search-line w-48 bg-transparent text-[13px] outline-none placeholder:text-faint"
          />
        </div>
        <div className="flex-1" />
        <AddPeopleFromApps />
        <button type="button" className="btn" onClick={() => setAdding(true)}>
          <Plus size={13} /> Add person
        </button>
      </div>
      {people.isPending ? (
        <Spinner />
      ) : people.isError && !people.data ? (
        <LoadError error={people.error} onRetry={() => void people.refetch()} retrying={people.isFetching} what="your people" />
      ) : list.length === 0 ? (
        wanted ? (
          <Empty>No one on today's work.</Empty>
        ) : all.length > 0 ? (
          <div className="empty-state flex flex-col items-start gap-3" data-people-no-match>
            <span className="text-[14px] font-medium text-ink">No people match “{search.trim()}”</span>
            <span>{plural(all.length, "person", "people")} saved. Clear the filter to see everyone.</span>
            <button type="button" className="btn" onClick={() => setSearch("")}>Clear filter</button>
          </div>
        ) : (
          <div className="empty-state flex flex-col items-start gap-3" data-people-empty>
            <span className="flex items-center gap-2 text-[14px] font-medium text-ink"><Users size={15} /> Add the people you work with</span>
            <span>Teammates, clients, advisors, or classmates. Mention them on pages and tasks, and they appear on the graph. Connected mail, chat, and reviews add more as they sync.</span>
            <button type="button" className="btn-primary" onClick={() => setAdding(true)}>Add a person</button>
          </div>
        )
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,270px),1fr))] gap-3">
          {list.map((person) => (
            <PersonCard key={person.id} person={person} focused={person.id === focusId} />
          ))}
        </div>
      )}
      <Dialog open={adding} onClose={close} title="Add a person">
        <form className="space-y-3" noValidate onSubmit={submit}>
          <Field label="Name">
            <input
              autoFocus
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setDuplicate(null);
              }}
              className="field w-full"
            />
          </Field>
          <Field label="Email (optional)">
            <input
              ref={emailRef}
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setEmailError(null);
                setDuplicate(null);
              }}
              aria-invalid={emailError ? true : undefined}
              aria-describedby={emailError ? emailErrorId : undefined}
              className="field w-full"
            />
            {emailError ? (
              <span id={emailErrorId} role="alert" className="mt-1 block text-[12px] font-normal text-danger">
                {emailError}
              </span>
            ) : null}
          </Field>
          <Field label="Role (optional)">
            <input value={role} onChange={(event) => setRole(event.target.value)} placeholder="e.g. Advisor, client, teammate" className="field w-full" />
          </Field>
          {duplicate ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-[13px]" data-person-duplicate>
              <span className="min-w-0 flex-1 text-ink">{duplicate.message}</span>
              {duplicate.person ? (
                <button type="button" className="btn" onClick={() => showPerson(duplicate.person!)}>
                  Show {duplicate.person.name}
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="flex justify-end">
            <button type="submit" className="btn-primary" disabled={!name.trim() || create.isPending || Boolean(duplicate)}>
              {create.isPending ? "Adding…" : "Add person"}
            </button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
