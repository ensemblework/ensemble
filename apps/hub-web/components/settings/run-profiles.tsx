"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MAX_RUN_PROFILES, type RunProfile, type Settings } from "@ensemble/shared-types";
import { confirmAction } from "@/components/ask-dialog";
import { api } from "@/lib/api";
import { agentFields, canAddProfile, defaultProfile, newProfileId, profileAgent, profileSummary, quickProfile, removeProfile } from "@/lib/run-profiles";
import { useModuleOn } from "@/lib/use-module";
import { AgentPicker, TuningPicker, agentOptions, modelOf } from "../agent/agent-picker";
import { SectionCard, Toggle, cx } from "../ui";
import { activeComputer } from "./subscriptions";

type Props = { settings: Settings; patch: (value: Record<string, unknown>) => void };

const MODES: Array<{ id: RunProfile["mode"]; label: string }> = [
  { id: "ask", label: "Ask" },
  { id: "review", label: "Review only" },
  { id: "unattended", label: "Run unattended" },
];

const GIT: Array<{ id: RunProfile["delivery"]; label: string }> = [
  { id: "push", label: "No limits" },
  { id: "commit", label: "Commit" },
  { id: "local", label: "Local only" },
];

function Choice<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ id: T; label: string }>; onChange: (value: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="thinking-levels">
      {options.map((option) => (
        <button key={option.id} type="button" role="radio" aria-checked={value === option.id} onClick={() => onChange(option.id)} className={cx("thinking-level", value === option.id && "is-on")}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** One profile's main choices, edited in place: who does the work, where, the mode, git and safety. */
function ProfileEditor({ profile, onChange }: { profile: RunProfile; onChange: (next: RunProfile) => void }) {
  const catalog = useQuery({ queryKey: ["models"], queryFn: api.models, staleTime: 5 * 60_000 });
  const subscriptions = useQuery({ queryKey: ["subscriptions"], queryFn: api.subscriptions, staleTime: 30_000 });
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, staleTime: 30_000 });
  const computer = (profile.deviceId ? subscriptions.data?.computers.find((row) => row.id === profile.deviceId) : null) ?? activeComputer(subscriptions.data);
  const agents = agentOptions({ catalog: catalog.data, computer });
  const choice = profileAgent(profile);
  const set = (fields: Partial<RunProfile>) => onChange({ ...profile, ...fields });
  return (
    <div className="mt-2 space-y-3 rounded-lg border border-line bg-raised p-3 text-[12.5px]" data-testid="profile-editor">
      <div>
        <div className="mb-1 font-medium text-muted">Agent</div>
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <AgentPicker label={`${profile.name}: agent and model`} agents={agents} value={choice} auto={{ text: "uses Settings → Models for the task's complexity", choice: null }} onChange={(next) => set(agentFields(next))} />
          </div>
          {choice ? <TuningPicker label={`${profile.name}: thinking and context`} value={choice} model={modelOf(agents, choice)} onChange={(next) => set(agentFields(next))} /> : null}
        </div>
      </div>
      {devices.data?.devices.length ? (
        <label className="block">
          <span className="mb-1 block font-medium text-muted">Runs on</span>
          <select aria-label={`${profile.name}: runs on`} className="field w-full" value={profile.deviceId ?? ""} onChange={(event) => set({ deviceId: event.target.value || null })}>
            <option value="">{devices.data.serverRunner ? "This computer" : "A paired computer that is online"}</option>
            {devices.data.devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div>
        <div className="mb-1 font-medium text-muted">Mode</div>
        <Choice label={`${profile.name}: mode`} value={profile.mode} options={MODES} onChange={(mode) => set({ mode })} />
      </div>
      <div>
        <div className="mb-1 font-medium text-muted">Git</div>
        <Choice label={`${profile.name}: git`} value={profile.delivery} options={GIT} onChange={(delivery) => set({ delivery, pullRequest: null })} />
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <label className="flex items-center gap-2">
          <Toggle checked={profile.sandbox} onChange={(sandbox) => set({ sandbox })} label={`${profile.name}: sandbox`} /> Sandbox
        </label>
        <label className="flex items-center gap-2">
          <Toggle checked={profile.network} onChange={(network) => set({ network })} label={`${profile.name}: internet`} /> Internet
        </label>
        <label className="flex items-center gap-2">
          <Toggle checked={profile.markDone} onChange={(markDone) => set({ markDone })} label={`${profile.name}: move to Done`} /> Move the task to Done
        </label>
      </div>
      <SecretNames profile={profile} onChange={(secrets) => set({ secrets: secrets.length ? secrets : undefined })} />
      <p className="text-[11.5px] text-faint">Branches, pull requests, instructions and limits are in Assign to agent → More options; save them there with “Save to”.</p>
    </div>
  );
}

/** The saved secrets a run with this profile may have on the computer, by name (docs/35 §8.7). */
function SecretNames({ profile, onChange }: { profile: RunProfile; onChange: (names: string[]) => void }) {
  const saved = (profile.secrets ?? []).join(", ");
  const [text, setText] = useState(saved);
  useEffect(() => setText(saved), [saved]);
  const commit = () => {
    const names = [...new Set(text.split(/[\s,]+/).map((name) => name.trim().toUpperCase()).filter((name) => /^[A-Z][A-Z0-9_]{1,63}$/.test(name)))].slice(0, 20);
    setText(names.join(", "));
    if (names.join(", ") !== saved) onChange(names);
  };
  return (
    <label className="block">
      <span className="mb-1 block font-medium text-muted">Secrets these runs may have</span>
      <input className="field w-full font-mono" aria-label={`${profile.name}: secrets`} value={text} placeholder="STRIPE_KEY, NPM_TOKEN" spellCheck={false} onChange={(event) => setText(event.target.value)} onBlur={commit} />
      <span className="mt-1 block text-[11.5px] text-faint">
        Names of secrets saved on the computer (<code>ensemble secrets</code>). Listed: a run gets only these. Empty: the computer decides: every saved secret in its compatibility mode, none in named mode.
      </span>
    </label>
  );
}

/** The saved run profiles: up to three, one the default. Each is edited here or in Assign to agent. */
export function RunProfilesSection({ settings, patch }: Props) {
  const on = useModuleOn("workspace");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) field.current?.select();
  }, [renaming]);
  if (!on) return null;
  const saved = settings.runProfiles;
  const chosen = defaultProfile(saved, settings.defaultRunProfileId, quickProfile(settings.orchestration));
  const rename = (id: string) => {
    const next = name.trim().slice(0, 40);
    if (next) patch({ runProfiles: saved.map((row) => (row.id === id ? { ...row, name: next } : row)) });
    setRenaming(null);
  };
  const update = (next: RunProfile) => patch({ runProfiles: saved.map((row) => (row.id === next.id ? next : row)) });
  const create = () => {
    const base = saved.length ? chosen : quickProfile(settings.orchestration);
    const taken = new Set(saved.map((row) => row.name));
    let label = saved.length ? `Profile ${saved.length + 1}` : "My default";
    for (let index = saved.length + 2; taken.has(label); index += 1) label = `Profile ${index}`;
    const profile: RunProfile = { ...base, id: newProfileId(), name: label };
    patch({ runProfiles: [...saved, profile], ...(saved.length ? {} : { defaultRunProfileId: profile.id }) });
    setOpen(profile.id);
  };
  const remove = async (profile: RunProfile) => {
    if (!(await confirmAction({ title: `Delete the “${profile.name}” profile?`, body: "Runs that already used it are not changed.", confirm: "Delete", danger: true }))) return;
    const list = removeProfile(saved, profile.id);
    patch({ runProfiles: list, ...(chosen.id === profile.id ? { defaultRunProfileId: list[0]?.id ?? null } : {}) });
  };
  return (
    <SectionCard title="Run profiles" info={`Up to ${MAX_RUN_PROFILES} saved ways to run a task. Quick assign and the assistant use the starred default.`}>
      {saved.length ? (
        <ul className="divide-y divide-[var(--line)]" role="radiogroup" aria-label="Default run profile">
          {saved.map((profile) => {
            const isDefault = profile.id === chosen.id;
            return (
              <li key={profile.id} className="py-2.5">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isDefault}
                    aria-label={isDefault ? `“${profile.name}” is the default` : `Make “${profile.name}” the default`}
                    title={isDefault ? "The default profile" : "Make this the default"}
                    onClick={() => !isDefault && patch({ defaultRunProfileId: profile.id })}
                    className={cx("grid h-7 w-7 shrink-0 place-items-center rounded-full transition-colors", isDefault ? "text-accent" : "text-faint hover:text-ink")}
                  >
                    <Star size={15} className={isDefault ? "fill-current" : undefined} />
                  </button>
                  <div className="min-w-0 flex-1">
                    {renaming === profile.id ? (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          rename(profile.id);
                        }}
                      >
                        <input
                          ref={field}
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                          onBlur={() => rename(profile.id)}
                          onKeyDown={(event) => event.key === "Escape" && (event.stopPropagation(), setRenaming(null))}
                          maxLength={40}
                          aria-label="Profile name"
                          className="field h-8 w-full max-w-[16rem] py-0 text-[13px]"
                        />
                      </form>
                    ) : (
                      <button type="button" className="flex items-center gap-2 text-left text-[13.5px] font-medium text-ink" aria-expanded={open === profile.id} onClick={() => setOpen(open === profile.id ? null : profile.id)}>
                        <ChevronRight size={13} className={cx("shrink-0 text-faint transition-transform", open === profile.id && "rotate-90")} />
                        {profile.name}
                        {isDefault ? <span className="rounded-full bg-[var(--accent-soft)] px-2 py-px text-[11px] font-medium text-accent">Default</span> : null}
                      </button>
                    )}
                    <div className="truncate pl-[21px] text-[12px] text-muted">{profileSummary(profile)}</div>
                  </div>
                  <button
                    type="button"
                    className="btn-ghost h-7 px-1.5"
                    aria-label={`Rename “${profile.name}”`}
                    title="Rename"
                    onClick={() => {
                      setName(profile.name);
                      setRenaming(profile.id);
                    }}
                  >
                    <Pencil size={13} />
                  </button>
                  <button type="button" className="btn-ghost h-7 px-1.5" aria-label={`Delete “${profile.name}”`} title="Delete" onClick={() => void remove(profile)}>
                    <Trash2 size={13} />
                  </button>
                </div>
                {open === profile.id ? <ProfileEditor profile={profile} onChange={update} /> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">No saved profiles: Quick assign uses the built-in one ({profileSummary(chosen)}).</p>
      )}
      {canAddProfile(saved) ? (
        <button type="button" className="btn mt-3" onClick={create}>
          <Plus size={13} /> New profile
        </button>
      ) : (
        <p className="mt-3 text-[12px] text-faint">Three profiles saved. Delete one to make another.</p>
      )}
    </SectionCard>
  );
}
