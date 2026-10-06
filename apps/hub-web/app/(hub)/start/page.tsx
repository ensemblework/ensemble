"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import { ProfileForm } from "@/components/profile-form";

const ROLES = [
  ["student", "Student", "Assignments, exams, and the people on the work."],
  ["teacher", "Teacher", "Lessons, check-ins, and the marking pile."],
  ["lawyer", "Lawyer", "A matter, two drafts, and the dates."],
  ["engineer", "Engineer", "A branch, a review, and who knows the code."],
  ["vibe", "Vibe coder", "One idea. Fewer tiles. The engineer preset, a quieter desk."],
  ["manager", "Manager", "The week, the 1:1s, and what you already decided."],
] as const;

export default function StartPage() {
  const toast = useToast();
  const client = useQueryClient();
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 15_000 });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 30_000 });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  const [role, setRole] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const cards = useQuery({
    queryKey: ["onboarding-templates", role],
    queryFn: () => api.onboardingTemplates(role ?? ""),
    enabled: Boolean(role),
  });
  const light = settings.data?.settings.appearance.theme === "light";

  const apply = useMutation({
    mutationFn: () => api.completeOnboarding(role ?? "", templateId ?? ""),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["shell"] });
      window.location.href = "/today";
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const profile = useMutation({
    mutationFn: api.updateProfile,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["me"] });
      await client.invalidateQueries({ queryKey: ["shell"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });

  if (me.data?.profileComplete === false) {
    return (
      <div className="mx-auto max-w-[640px] px-4 pb-24 pt-16">
        <p className="page-kicker mb-2">About you</p>
        <h1 className="display text-[32px] leading-none">Tell Ensemble what to call you</h1>
        <p className="mt-3 max-w-[46ch] text-[14px] leading-6 text-muted">
          These fields are optional except your name. They help personalize labels and can be changed later in Settings.
        </p>
        <div className="tile mt-6 rounded-2xl p-4">
          <ProfileForm
            initial={{ name: me.data.user.name, profile: me.data.user.profile }}
            submitLabel="Continue"
            pending={profile.isPending}
            onSubmit={(values) => profile.mutate(values)}
          />
        </div>
      </div>
    );
  }

  if (shell.data?.onboardingComplete) {
    return (
      <div className="mx-auto max-w-[640px] px-4 pt-16">
        <h1 className="display text-[32px] leading-none">You're set up</h1>
        <p className="mt-3 max-w-[42ch] text-[14px] leading-6 text-muted">Today is the desk. Context holds the people and projects that work is tied to. You can change the layout whenever you want.</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link href="/today" className="btn-primary">
            Go to Today
          </Link>
          <Link href="/context" className="btn">
            Open Context
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[980px] px-4 pb-24 pt-10 sm:px-8">
      <div className="page-head">
      <div>
      <h1 className="display text-[32px] leading-none">Pick a desk</h1>
      <p className="mt-2 max-w-[46ch] text-[14px] text-muted">A role, then a template. You can move the tiles later. This does not change what Ensemble is allowed to do.</p>
      </div>
      </div>

      <h2 className="page-kicker mb-2">Role</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-role-picker>
        {ROLES.map(([id, name, blurb]) => (
          <button
            key={id}
            type="button"
            data-role={id}
            aria-pressed={role === id}
            onClick={() => {
              setRole(id);
              setTemplateId(null);
            }}
            className={`tile lift relative rounded-xl px-3 py-3 text-left ${role === id ? "bg-accent-soft ring-2 ring-accent" : ""}`}
          >
            {role === id ? <span className="on-accent absolute right-2 top-2 rounded-full px-1.5 py-px text-[10px] font-medium">Selected</span> : null}
            <div className="text-[14px] font-semibold">{name}</div>
            <p className="mt-1 text-[12.5px] leading-5 text-muted">{blurb}</p>
          </button>
        ))}
      </div>

      {role ? (
        <div className="mt-8" data-template-picker>
          <h2 className="text-[15px] font-semibold">Choose one</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(cards.data?.templates ?? []).map((card) => (
              <button
                key={card.id}
                type="button"
                data-template={card.id}
                aria-pressed={templateId === card.id}
                onClick={() => setTemplateId(card.id)}
                className={`tile lift relative overflow-hidden rounded-xl text-left ${templateId === card.id ? "bg-accent-soft ring-2 ring-accent" : ""}`}
              >
                {templateId === card.id ? <span className="on-accent absolute right-2 top-2 z-10 rounded-full px-1.5 py-px text-[10px] font-medium">Selected</span> : null}
                <img src={light ? card.imageLight : card.image} alt="" className="aspect-[8/5] w-full bg-panel object-contain" />
                <div className="px-3 py-3">
                  <div className="text-[14px] font-semibold">{card.name}</div>
                  <p className="mt-1 text-[12.5px] leading-5 text-muted">{card.blurb}</p>
                </div>
              </button>
            ))}
          </div>
          <button type="button" className="btn-primary mt-4" disabled={!templateId || apply.isPending} onClick={() => apply.mutate()}>
            {apply.isPending ? "Setting up…" : "Use this template"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
