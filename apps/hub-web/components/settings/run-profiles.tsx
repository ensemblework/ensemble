"use client";

import { Pencil, Star, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RunProfile, Settings } from "@ensemble/shared-types";
import { confirmAction } from "@/components/ask-dialog";
import { defaultProfile, profileSummary, quickProfile, removeProfile } from "@/lib/run-profiles";
import { useModuleOn } from "@/lib/use-module";
import { SectionCard, cx } from "../ui";

type Props = { settings: Settings; patch: (value: Record<string, unknown>) => void };

/** The saved run profiles: which one is the default, their names, removing one. Their settings are edited in Assign to agent. */
export function RunProfilesSection({ settings, patch }: Props) {
  const on = useModuleOn("workspace");
  const [renaming, setRenaming] = useState<string | null>(null);
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
  const remove = async (profile: RunProfile) => {
    if (!(await confirmAction({ title: `Delete the “${profile.name}” profile?`, body: "Runs that already used it are not changed.", confirm: "Delete", danger: true }))) return;
    const list = removeProfile(saved, profile.id);
    patch({ runProfiles: list, ...(chosen.id === profile.id ? { defaultRunProfileId: list[0]?.id ?? null } : {}) });
  };
  return (
    <SectionCard
      title="Run profiles"
      description="Saved Assign to agent settings. Quick assign and the assistant use the starred one unless you name another, for example “assign it with my Careful profile”."
    >
      {saved.length ? (
        <ul className="divide-y divide-[var(--line)]" role="radiogroup" aria-label="Default run profile">
          {saved.map((profile) => {
            const isDefault = profile.id === chosen.id;
            return (
              <li key={profile.id} className="flex items-center gap-3 py-2.5">
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
                    <div className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
                      {profile.name}
                      {isDefault ? <span className="rounded-full bg-[var(--accent-soft)] px-2 py-px text-[11px] font-medium text-accent">Default</span> : null}
                    </div>
                  )}
                  <div className="truncate text-[12px] text-muted">{profileSummary(profile)}</div>
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
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">No profiles yet. In Assign to agent on any task, choose how the agent should work and press Save as profile (up to three).</p>
      )}
    </SectionCard>
  );
}
