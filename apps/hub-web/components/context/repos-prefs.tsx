"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, GitBranch, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import { relative } from "@/lib/format";
import { useToast } from "../toast";
import { DiagramCard } from "../diagrams/diagram-card";
import { useModuleOn } from "@/lib/use-module";
import { MakeDiagramButton, repoDiagramPrompt } from "../diagrams/make-diagram";
import { Empty, InlineEdit, Spinner, Tag, Toggle } from "../ui";

export function ReposTab() {
  const client = useQueryClient();
  const toast = useToast();
  const repos = useQuery({ queryKey: ["repos"], queryFn: api.repos });
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => api.addRepo(name.trim()),
    onSuccess: () => {
      setName("");
      void client.invalidateQueries({ queryKey: ["repos"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const track = useMutation({
    mutationFn: (input: { id: string; tracked: boolean }) => api.patchRepo(input.id, { tracked: input.tracked }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["repos"] }),
  });
  const diagramsOn = useModuleOn("diagrams");
  const diagrams = useQuery({ queryKey: ["diagram-links", "repo"], queryFn: () => api.diagramLinks({ targetKind: "repo" }), enabled: diagramsOn });
  const list = repos.data?.repos ?? [];
  const linked = diagramsOn ? (diagrams.data?.links ?? []) : [];
  return (
    <div>
      {linked.length ? (
        <section className="mb-6">
          <h3 className="mb-2 text-[13px] font-semibold">Diagrams</h3>
          <div className="space-y-3">
            {linked.map((link) => (
              <DiagramCard key={link.id} id={link.diagram.id} label={link.diagram.title} />
            ))}
          </div>
        </section>
      ) : null}
      <form
        className="mb-4 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) add.mutate();
        }}
      >
        <span className="text-[13px] font-semibold">{list.length} repositories</span>
        <div className="flex-1" />
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="owner/repo" className="field w-56" />
        <button type="submit" className="btn" disabled={!name.trim()}>
          <Plus size={13} /> Track
        </button>
      </form>
      {repos.isLoading ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty>No repositories yet. Connect GitHub, or track one by name.</Empty>
      ) : (
        <div className="space-y-1.5">
          {list.map((repo) => (
            <div key={repo.id} className="tile lift flex items-center gap-3 rounded-xl bg-panel px-3 py-2.5 text-[13px]">
              <span className="kind-dot" style={{ ["--kind" as string]: "var(--kind-repo)" }} />
              <GitBranch size={15} className="text-muted" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{repo.fullName}</span>
                  <Tag tone="gray">{repo.myRole}</Tag>
                  {repo.languages.slice(0, 3).map((language) => (
                    <Tag key={language} tone="purple">
                      {language}
                    </Tag>
                  ))}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
                  <span className="truncate">{repo.description ?? "No description"}</span>
                  {repo.projects.map((project) => (
                    <span key={project.id} className="chip" style={{ ["--chip" as string]: "var(--kind-project)" }}>
                      {project.name}
                    </span>
                  ))}
                  <span>synced {relative(repo.lastSyncedAt)}</span>
                </div>
              </div>
              <MakeDiagramButton needsCode text={repoDiagramPrompt(repo.id, repo.fullName)} />
              {repo.url ? (
                <a href={repo.url} target="_blank" rel="noreferrer" className="icon-btn" title="Open on GitHub">
                  <ExternalLink size={13} />
                </a>
              ) : null}
              <span className="flex items-center gap-2 text-[12px] text-muted">
                Track
                <Toggle label={`Track ${repo.fullName}`} checked={repo.tracked} onChange={(tracked) => track.mutate({ id: repo.id, tracked })} />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PreferencesTab() {
  const client = useQueryClient();
  const preferences = useQuery({ queryKey: ["preferences"], queryFn: api.preferences });
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const put = useMutation({
    mutationFn: (input: { key: string; value: string }) => api.putPreference(input.key, input.value),
    onSuccess: () => {
      setKey("");
      setValue("");
      void client.invalidateQueries({ queryKey: ["preferences"] });
    },
  });
  const remove = useMutation({
    mutationFn: (name: string) => api.deletePreference(name),
    onSuccess: () => client.invalidateQueries({ queryKey: ["preferences"] }),
  });
  const list = preferences.data?.preferences ?? [];
  return (
    <div>
      <p className="mb-4 max-w-2xl text-[13px] text-muted">
        What the agent has learned about how you work — and anything you tell it directly. Declared preferences always win over inferred ones.
      </p>
      <form
        className="tile mb-4 flex items-center gap-2 rounded-md bg-panel p-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (key.trim() && value.trim()) put.mutate({ key: key.trim(), value: value.trim() });
        }}
      >
        <input value={key} onChange={(event) => setKey(event.target.value)} placeholder="e.g. meeting.no-before" className="field w-56" />
        <input value={value} onChange={(event) => setValue(event.target.value)} placeholder="e.g. 10:00" className="field flex-1" />
        <button type="submit" className="btn" disabled={!key.trim() || !value.trim()}>
          <Plus size={13} /> Add
        </button>
      </form>
      {preferences.isLoading ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty>No preferences yet.</Empty>
      ) : (
        <div className="divide-y divide-[var(--line)] rounded-md border border-line">
          {list.map((row) => (
            <div key={row.id} className="row-tile group flex items-center gap-4 px-3 py-2 text-[13px]">
              <span className="w-64 shrink-0 font-mono text-[12px]">{row.key}</span>
              <div className="min-w-0 flex-1">
                <InlineEdit
                  value={typeof row.value === "string" ? row.value : JSON.stringify(row.value)}
                  onSave={(next) => put.mutate({ key: row.key, value: next })}
                />
              </div>
              <Tag tone={row.source === "me" ? "blue" : "gray"}>{row.source === "me" ? "declared" : `learned · ${Math.round(row.confidence * 100)}%`}</Tag>
              <button type="button" className="icon-btn h-6 w-6 opacity-0 group-hover:opacity-100" onClick={() => remove.mutate(row.key)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
