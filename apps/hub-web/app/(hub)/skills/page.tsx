"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, Search, Sparkles } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/toast";
import { Empty, PageHeader, SkeletonRows, Tag, Toggle, cx } from "@/components/ui";
import { api, type SkillRecord } from "@/lib/api";
import { ShareButton } from "@/components/sharing/share-dialog";
import { dateTime } from "@/lib/format";
import { askText } from "@/components/ask-dialog";
import { ExportMenu } from "@/components/export-menu";
import { skillDoc } from "@/lib/export/items";

function SkillDetail({ skill }: { skill: SkillRecord }) {
  const client = useQueryClient();
  const toast = useToast();
  const [body, setBody] = useState(skill.body);
  const [state, setState] = useState<"saved" | "saving" | "dirty">("saved");
  const [history, setHistory] = useState(false);
  const [draft, setDraft] = useState("");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    setBody(skill.body);
    setState("saved");
  }, [skill.id, skill.body]);

  const save = useMutation({
    mutationFn: (value: string) => api.patchSkill(skill.id, { body: value }),
    onMutate: () => setState("saving"),
    onSuccess: () => {
      setState("saved");
      void client.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (error) => {
      setState("dirty");
      toast((error as Error).message, { tone: "error" });
    },
  });
  const restore = useMutation({
    mutationFn: (version: number) => api.restoreSkill(skill.id, version),
    onSuccess: () => client.invalidateQueries({ queryKey: ["skills"] }),
  });
  const score = useMutation({ mutationFn: () => api.scoreSkill(skill.id, draft) });

  return (
    <div className="tile min-w-0 rounded-lg bg-panel p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[18px] font-semibold">{skill.name}</h2>
        <div className="flex items-center gap-1">
          <ExportMenu load={() => skillDoc({ ...skill, body })} />
          <ShareButton target={{ kind: "skill", resourceId: skill.id, title: skill.name }} />
        </div>
      </div>
      <textarea
        value={body}
        onChange={(event) => {
          setBody(event.target.value);
          setState("dirty");
          window.clearTimeout(timer.current);
          const value = event.target.value;
          timer.current = window.setTimeout(() => save.mutate(value), 900);
        }}
        spellCheck={false}
        className="field mt-3 h-[340px] w-full resize-y font-mono text-[12.5px] leading-5"
      />
      <div className="mt-1.5 text-[12.5px] text-muted">
        {state === "saved" ? "All skill changes saved." : state === "saving" ? "Saving…" : "Unsaved changes"}
      </div>
      <p className="mt-1 text-[12.5px] text-muted">
        Body edits save automatically after a short pause and create a new version. Regeneration and testing run only when you click.
      </p>

      <button type="button" onClick={() => setHistory(!history)} className="mt-3 flex items-center gap-1 text-[13px] font-medium">
        <ChevronRight size={13} className={cx("transition-transform", history && "rotate-90")} />
        Version history · latest three, including current
      </button>
      {history ? (
        <div className="mt-2 space-y-1">
          {skill.versions.map((version) => (
            <div key={version.id} className="row-tile flex items-center justify-between rounded-md px-2 py-1.5 text-[12.5px]">
              <span>
                v{version.version} · {version.note ?? "edit"} · <span className="text-muted">{dateTime(version.createdAt)}</span>
              </span>
              {version.version === skill.version ? (
                <Tag tone="green">current</Tag>
              ) : (
                <button type="button" className="btn-ghost py-0 text-[12px]" onClick={() => restore.mutate(version.version)}>
                  Restore
                </button>
              )}
            </div>
          ))}
        </div>
      ) : null}

      <h3 className="mt-6 text-[15px] font-semibold">Test this skill</h3>
      <p className="text-[12.5px] text-muted">Paste a draft. It is scored against this skill&apos;s machine-checkable rules.</p>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={4}
        placeholder="Paste a draft reply or PR body…"
        className="field mt-2 w-full"
      />
      <button type="button" className="btn mt-2" disabled={!draft.trim() || score.isPending} onClick={() => score.mutate()}>
        Score draft
      </button>
      {score.data ? (
        <div className="mt-3 space-y-1 text-[13px]">
          <div className="font-medium">
            {score.data.score === null ? "No rules to check." : `${Math.round(score.data.score * 100)}% of rules pass`} · {score.data.words} words
          </div>
          {score.data.note ? <div className="text-muted">{score.data.note}</div> : null}
          {score.data.results.map((row) => (
            <div key={row.rule} className="flex items-center gap-2">
              <Tag tone={row.pass ? "green" : "red"}>{row.pass ? "pass" : "fail"}</Tag>
              <span className="font-mono text-[12px]">{row.rule}</span>
            </div>
          ))}
        </div>
      ) : null}

      <h3 className="mt-6 text-[15px] font-semibold">Evidence</h3>
      {skill.evidence.length ? (
        <ul className="mt-1 list-disc pl-5 text-[13px] text-muted">
          {skill.evidence.map((row) => (
            <li key={row}>{row}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[12.5px] text-muted">
          Nothing mined yet, this skill is a starting point. It improves from your feedback even before any history is connected.
        </p>
      )}
    </div>
  );
}

export default function SkillsPage() {
  const client = useQueryClient();
  const toast = useToast();
  const params = useSearchParams();
  const router = useRouter();
  const skills = useQuery({ queryKey: ["skills"], queryFn: api.skills });
  const [search, setSearch] = useState("");
  const list = (skills.data?.skills ?? []).filter((skill) => skill.name.toLowerCase().includes(search.toLowerCase()));
  const selectedId = params.get("skill") ?? list[0]?.id;
  const selected = skills.data?.skills.find((skill) => skill.id === selectedId);

  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) => api.patchSkill(input.id, { enabled: input.enabled }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["skills"] }),
  });
  const create = useMutation({
    mutationFn: async () => {
      const name = await askText({ title: "New skill", label: "What should the agent get good at?", placeholder: "Writing release notes", confirm: "Create skill" });
      if (!name) return null;
      return api.createSkill(name);
    },
    onSuccess: (created) => {
      if (!created) return;
      void client.invalidateQueries({ queryKey: ["skills"] });
      router.replace(`/skills?skill=${created.skill.id}`);
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });

  return (
    <div className="mx-auto max-w-[1180px] px-10 pb-24 pt-8">
      <PageHeader
        title="Skill library"
        description="Make the agent's work feel like yours. Review its guidelines, test a draft, and build on what it learns from your feedback."
      />
      <div className="tile mb-6 flex w-full items-start gap-3 rounded-xl bg-panel px-4 py-3 text-left">
        <Sparkles size={16} className="mt-0.5 shrink-0 text-accent" />
        <span className="min-w-0">
          <span className="block text-[15px] font-semibold">Improve skills from my work</span>
          <span className="mt-0.5 block text-[12.5px] font-normal leading-5 text-muted">
            Coming soon. Completed work is saved as a compact record so a future skill miner can learn from it. Nothing is queued yet.
          </span>
        </span>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div>
          <div className="tile flex items-center gap-1.5 rounded-md bg-panel px-2 py-1.5">
            <Search size={13} className="text-faint" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search skills…"
              className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
            />
          </div>
          <div className="mb-2 mt-3 flex items-center justify-between text-[12.5px] text-muted">
            <span>{list.length} skills</span>
            <button type="button" className="btn-ghost py-0.5" onClick={() => create.mutate()}>
              <Plus size={13} /> New skill
            </button>
          </div>
          {skills.isLoading ? (
            <SkeletonRows count={6} />
          ) : list.length === 0 ? (
            <Empty>No skills yet. Create one to teach the agent how you like things done.</Empty>
          ) : (
            <div className="space-y-2">
              {list.map((skill) => (
                <div
                  key={skill.id}
                  role="button"
                  onClick={() => router.replace(`/skills?skill=${skill.id}`)}
                  className={cx(
                    "tile cursor-pointer rounded-md px-3 py-2.5",
                    skill.id === selectedId ? "bg-accent-soft" : "bg-panel",
                  )}
                  data-active={skill.id === selectedId || undefined}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[13.5px] font-semibold">{skill.name}</span>
                    <span onClick={(event) => event.stopPropagation()}>
                      <Toggle label={`Enable ${skill.name}`} checked={skill.enabled} onChange={(enabled) => toggle.mutate({ id: skill.id, enabled })} />
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-[12px] text-muted">
                    <Tag tone="blue">{skill.provenance === "declared" ? "your rule" : skill.provenance}</Tag>
                    <span>v{skill.version}</span>
                    <Tag tone="gray">{Math.round(skill.confidence * 100)}%</Tag>
                  </div>
                  <div className="mt-1 text-[12px] text-faint">
                    {skill.minedFrom ? `mined from ${skill.minedFrom} examples` : "no history mined yet"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {selected ? <SkillDetail skill={selected} /> : <div />}
      </div>
    </div>
  );
}
