"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, Lock, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type SpaceSettingsMode } from "@/lib/api";
import { announceSpace, enterSpace, SPACE_ICONS, spaceInitial } from "@/lib/spaces";
import { useToast } from "@/components/toast";
import { Splash } from "@/components/motion/skeletons";
import { TemplateList, TemplateStage } from "@/components/onboarding/template-picker";
import { ROLES, type Role } from "@/components/onboarding/roles";
import { SpaceIcon } from "@/components/shell/space-switcher";
import { cx } from "@/components/ui";

type Step = "name" | "template" | "settings";
const STEPS: Array<[Step, string]> = [
  ["name", "Name"],
  ["template", "Template"],
  ["settings", "Settings"],
];

/** Names people tend to give a second line of work, per role. Tapping one fills the field. */
const IDEAS: Record<Role, string[]> = {
  student: ["Thesis", "Internship hunt", "Club", "Side project"],
  teacher: ["Department", "Tutoring", "Exam board", "Personal"],
  lawyer: ["Pro bono", "Firm admin", "Research", "Personal"],
  engineer: ["Side project", "Open source", "On-call", "Personal"],
  vibe: ["Second idea", "Client work", "Learning", "Personal"],
  manager: ["Hiring", "Leadership team", "Side project", "Personal"],
};

const SEPARATE = ["Tasks and pages", "People and the graph", "Files and plots", "Connected apps", "Assistant history"];

export default function NewSpacePage() {
  const router = useRouter();
  const toast = useToast();
  const spaces = useQuery({ queryKey: ["spaces"], queryFn: api.spaces, staleTime: 30_000 });
  const accountRole = (spaces.data?.account.role ?? null) as Role | null;
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [pickedRole, setPickedRole] = useState<Role | null>(null);
  const role = accountRole ?? pickedRole;
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [mode, setMode] = useState<SpaceSettingsMode>("copy");
  const [from, setFrom] = useState<string | null>(null);
  const sync = spaces.data?.account.sync === true;

  const cards = useQuery({
    queryKey: ["onboarding-templates", role],
    queryFn: () => api.onboardingTemplates(role ?? ""),
    enabled: Boolean(role),
    staleTime: 5 * 60_000,
  });
  const list = cards.data?.templates ?? [];
  const selected = list.find((card) => card.id === templateId) ?? list[0] ?? null;
  useEffect(() => {
    if (spaces.data && !from) setFrom(spaces.data.activeId);
  }, [spaces.data, from]);

  const create = useMutation({
    mutationFn: () =>
      api.createSpace({
        name: name.trim(),
        icon,
        templateId: selected?.id ?? "",
        settings: sync || mode !== "fresh" ? { mode: sync ? "copy" : mode, from: from ?? undefined } : { mode: "fresh" },
      }),
    onSuccess: (result) => {
      announceSpace(result.activeId);
      enterSpace("/today");
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });

  const index = STEPS.findIndex(([id]) => id === step);
  const canNext = step === "name" ? name.trim().length > 0 : step === "template" ? Boolean(selected) : true;
  const next = () => {
    if (!canNext || create.isPending) return;
    if (step === "name") setStep("template");
    else if (step === "template") setStep("settings");
    else create.mutate();
  };
  const ideas = IDEAS[role ?? "engineer"];
  const roleLabel = ROLES.find((item) => item.id === role)?.label.toLowerCase();
  const others = spaces.data?.spaces ?? [];

  return (
    <div className="onboard" data-step={step} data-new-space-flow>
      <aside className="onboard-side">
        <div className="flex items-center justify-between">
          <div className="onboard-brand">New space</div>
          <button type="button" className="icon-btn" aria-label="Cancel" title="Cancel" onClick={() => (window.history.length > 1 ? router.back() : router.push("/today"))}>
            <X size={16} />
          </button>
        </div>
        <ol className="onboard-steps" aria-label="Steps">
          {STEPS.map(([id, label], position) => (
            <li key={id} data-on={id === step ? "1" : undefined} data-done={position < index ? "1" : undefined}>
              <span>{position < index ? <Check size={11} strokeWidth={3} /> : position + 1}</span>
              {label}
            </li>
          ))}
        </ol>

        <form
          className="onboard-form"
          key={step}
          onSubmit={(event) => {
            event.preventDefault();
            next();
          }}
        >
          {step === "name" ? (
            <>
              <h1 className="onboard-title">A new space for another line of work</h1>
              <p className="onboard-lede">Nothing crosses between spaces. What you add here stays here, and the assistant only sees the space it is in.</p>
              <div className="flex items-end gap-3">
                <SpaceIcon space={{ name: name || "S", icon }} size={42} />
                <label className="onboard-field min-w-0 flex-1">
                  <span>Name</span>
                  <input autoFocus required maxLength={60} className="field" value={name} onChange={(event) => setName(event.target.value)} placeholder={ideas[0]} data-space-name />
                </label>
              </div>
              <div className="onboard-chips -mt-2" aria-label="Ideas">
                {ideas.map((idea) => (
                  <button key={idea} type="button" aria-pressed={name === idea} onClick={() => setName(idea)}>
                    {idea}
                  </button>
                ))}
              </div>
              <div className="onboard-field">
                <span>
                  Icon <em>optional</em>
                </span>
                <div className="space-icon-grid" role="radiogroup" aria-label="Icon">
                  <button type="button" role="radio" aria-checked={icon === null} title="Use the first letter" onClick={() => setIcon(null)}>
                    {spaceInitial(name || "S")}
                  </button>
                  {SPACE_ICONS.map((emoji) => (
                    <button key={emoji} type="button" role="radio" aria-checked={icon === emoji} onClick={() => setIcon(emoji)}>
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : step === "template" ? (
            <>
              <h1 className="onboard-title">Start {name.trim()} from a template</h1>
              <p className="onboard-lede">
                {roleLabel ? `Templates for a ${roleLabel}, the role you picked at signup.` : "Pick what this space is for, then a template."} Every tile can be moved, resized, or hidden later.
              </p>
              {accountRole ? null : (
                <div className="onboard-chips" role="radiogroup" aria-label="What this space is for">
                  {ROLES.map((item) => (
                    <button key={item.id} type="button" role="radio" aria-checked={pickedRole === item.id} aria-pressed={pickedRole === item.id} onClick={() => { setPickedRole(item.id); setTemplateId(null); }}>
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
              {role ? <TemplateList cards={list} loading={cards.isLoading} role={role} selectedId={selected?.id ?? null} onPick={setTemplateId} /> : null}
            </>
          ) : (
            <>
              <h1 className="onboard-title">Settings for {name.trim()}</h1>
              <p className="onboard-lede">Theme, models and API keys, shortcuts, quiet hours. Each space keeps its own unless you choose otherwise.</p>
              {sync ? (
                <div className="space-option is-on" data-settings-mode="sync">
                  <span className="space-option-dot" />
                  <span className="min-w-0">
                    <span className="block text-[14px] font-medium text-ink">Kept in sync</span>
                    <span className="block text-[12.5px] leading-[1.45] text-muted">Your spaces share one set of settings, so this one starts with them and stays the same. You can turn this off in Settings, Spaces.</span>
                  </span>
                </div>
              ) : (
                <div className="flex flex-col gap-2" role="radiogroup" aria-label="Settings">
                  <SettingsOption on={mode === "copy"} onPick={() => setMode("copy")} title="Bring my settings" mode="copy">
                    A copy of the settings and model keys from{" "}
                    {others.length > 1 ? (
                      <select className="space-inline-select" value={from ?? ""} onChange={(event) => setFrom(event.target.value)} onClick={(event) => event.stopPropagation()} aria-label="Copy settings from">
                        {others.map((row) => (
                          <option key={row.id} value={row.id}>{row.name}</option>
                        ))}
                      </select>
                    ) : (
                      <b className="font-medium text-ink">{others[0]?.name ?? "this space"}</b>
                    )}
                    . Later changes stay in their own space.
                  </SettingsOption>
                  <SettingsOption on={mode === "sync"} onPick={() => setMode("sync")} title="Keep every space in sync" mode="sync">
                    One set of settings for all your spaces. A key or theme changed anywhere changes everywhere.
                  </SettingsOption>
                  <SettingsOption on={mode === "fresh"} onPick={() => setMode("fresh")} title="Start fresh" mode="fresh">
                    Default settings and no model keys. Add keys in Settings before using the assistant here.
                  </SettingsOption>
                </div>
              )}
              <div className="space-separate">
                <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
                  <Lock size={12} /> Always kept separate
                </div>
                <ul>
                  {SEPARATE.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </>
          )}
          <div className="onboard-actions">
            {index > 0 ? (
              <button type="button" className="btn" onClick={() => setStep(STEPS[index - 1]![0])}>
                <ArrowLeft size={14} />
                Back
              </button>
            ) : (
              <span />
            )}
            <button type="submit" className="btn-primary" data-space-next disabled={!canNext || create.isPending}>
              {step === "settings" ? (create.isPending ? "Creating…" : `Create ${name.trim()}`) : "Continue"}
              <ArrowRight size={14} />
            </button>
          </div>
        </form>
      </aside>

      <TemplateStage
        card={selected}
        role={role ?? ""}
        kicker={`${name.trim() || "New space"} · preview with sample data`}
        empty={role ? "Loading templates…" : "Pick what this space is for. A desk built for it shows up here."}
      />
      <Splash active={create.isPending || create.isSuccess} />
    </div>
  );
}

function SettingsOption({ on, onPick, title, mode, children }: { on: boolean; onPick: () => void; title: string; mode: SpaceSettingsMode; children: React.ReactNode }) {
  return (
    <div
      role="radio"
      tabIndex={0}
      aria-checked={on}
      data-settings-mode={mode}
      className={cx("space-option", on && "is-on")}
      onClick={onPick}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          onPick();
        }
      }}
    >
      <span className="space-option-dot" />
      <span className="min-w-0">
        <span className="block text-[14px] font-medium text-ink">{title}</span>
        <span className="block text-[12.5px] leading-[1.45] text-muted">{children}</span>
      </span>
    </div>
  );
}
