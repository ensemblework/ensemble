"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import { TemplateList, TemplateStage } from "@/components/onboarding/template-picker";
import { ROLES, roleFromProfession, type Role } from "@/components/onboarding/roles";

const HEARD = ["A friend or colleague", "X", "LinkedIn", "Search", "YouTube", "Somewhere else"];

export default function StartPage() {
  const toast = useToast();
  const client = useQueryClient();
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 15_000 });
  // Not ["me"]: the hub layout seeds that key from /shell, which does not carry profileComplete.
  const me = useQuery({ queryKey: ["me", "profile"], queryFn: api.me, staleTime: 30_000 });
  const profileDone = me.data?.profileComplete !== false;
  const [step, setStep] = useState<"you" | "desk">("you");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role | null>(null);
  const [org, setOrg] = useState("");
  const [heard, setHeard] = useState("");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (seeded || !me.data) return;
    setSeeded(true);
    setName(me.data.user.name && me.data.user.name !== me.data.user.email ? me.data.user.name : "");
    setOrg(me.data.user.profile?.organization ?? "");
    setHeard(me.data.user.profile?.heardFrom ?? "");
    setRole(roleFromProfession(me.data.user.profile?.profession));
  }, [me.data, seeded]);

  const cards = useQuery({
    queryKey: ["onboarding-templates", role],
    queryFn: () => api.onboardingTemplates(role ?? ""),
    enabled: Boolean(role),
    staleTime: 5 * 60_000,
  });
  const list = cards.data?.templates ?? [];
  const selected = list.find((card) => card.id === templateId) ?? list[0] ?? null;
  const roleInfo = ROLES.find((item) => item.id === role) ?? null;

  const profile = useMutation({
    mutationFn: () =>
      api.updateProfile({
        name: name.trim(),
        gender: me.data?.user.profile?.gender ?? null,
        profession: roleInfo?.profession ?? null,
        organization: org.trim() || null,
        heardFrom: heard || null,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["me"] });
      setStep("desk");
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const apply = useMutation({
    mutationFn: () => api.completeOnboarding(role ?? "", selected?.id ?? ""),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["shell"] });
      window.location.href = "/today";
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });

  if (shell.data?.onboardingComplete) {
    return (
      <div className="onboard-done">
        <div className="onboard-brand">Ensemble</div>
        <h1 className="display text-[34px] leading-tight">You're set up</h1>
        <p className="mt-2 max-w-[44ch] text-[14px] leading-6 text-muted">Today is your desk. Context holds the people and projects your work ties to. Tiles can be moved, resized, or hidden whenever you like.</p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Link href="/today" className="btn-primary">Go to Today</Link>
          <Link href="/context" className="btn">Open Context</Link>
        </div>
      </div>
    );
  }

  const canContinue = Boolean(role) && (profileDone || name.trim().length > 0);
  const next = () => {
    if (!canContinue) return;
    if (profileDone) setStep("desk");
    else profile.mutate();
  };

  return (
    <div className="onboard" data-step={step}>
      <aside className="onboard-side">
        <div className="onboard-brand">Ensemble</div>
        <ol className="onboard-steps" aria-label="Setup steps">
          <li data-on={step === "you" ? "1" : undefined} data-done={step === "desk" ? "1" : undefined}>
            <span>{step === "desk" ? <Check size={11} strokeWidth={3} /> : 1}</span>About you
          </li>
          <li data-on={step === "desk" ? "1" : undefined}>
            <span>2</span>Your desk
          </li>
        </ol>

        {!me.isSuccess ? (
          <div className="onboard-form" aria-busy="true">
            <div className="skeleton h-9 w-4/5 rounded-md" />
            <div className="skeleton h-4 w-3/5 rounded" />
            <div className="skeleton h-44 w-full rounded-md" />
          </div>
        ) : step === "you" ? (
          <form
            className="onboard-form"
            data-onboard-you
            onSubmit={(event) => {
              event.preventDefault();
              next();
            }}
          >
            <h1 className="onboard-title">{profileDone ? "What do you work on?" : "Welcome. Let's set up your space."}</h1>
            <p className="onboard-lede">One question picks your starting desk. Everything can change later.</p>
            {profileDone ? null : (
              <label className="onboard-field">
                <span>Your name</span>
                <input required maxLength={80} autoComplete="name" autoFocus className="field" value={name} onChange={(event) => setName(event.target.value)} placeholder="Mira Chen" />
              </label>
            )}
            <fieldset className="onboard-field">
              <legend>What do you do?</legend>
              <div className="onboard-roles" role="radiogroup" data-role-picker>
                {ROLES.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="radio"
                      aria-checked={role === item.id}
                      data-role={item.id}
                      className="onboard-role"
                      onClick={() => {
                        setRole(item.id);
                        setTemplateId(null);
                      }}
                    >
                      <Icon size={16} strokeWidth={1.8} />
                      <span className="min-w-0">
                        <span className="block text-[13.5px] font-medium text-ink">{item.label}</span>
                        <span className="block text-[12px] leading-[1.35] text-muted">{item.line}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
            {profileDone ? null : (
              <>
                <label className="onboard-field">
                  <span>
                    {roleInfo?.org ?? "Where you work or study"} <em>optional</em>
                  </span>
                  <input maxLength={80} autoComplete="organization" className="field" value={org} onChange={(event) => setOrg(event.target.value)} />
                </label>
                <div className="onboard-field">
                  <span>
                    How did you hear about us? <em>optional</em>
                  </span>
                  <div className="onboard-chips">
                    {HEARD.map((item) => (
                      <button key={item} type="button" aria-pressed={heard === item} onClick={() => setHeard(heard === item ? "" : item)}>
                        {item}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
            <div className="onboard-actions">
              <button type="submit" className="btn-primary" disabled={!canContinue || profile.isPending}>
                {profile.isPending ? "Saving…" : "Continue"}
                <ArrowRight size={14} />
              </button>
            </div>
          </form>
        ) : (
          <div className="onboard-form" data-template-picker>
            <h1 className="onboard-title">Pick a starting point</h1>
            <p className="onboard-lede">
              Six ways to start as {roleInfo ? (/^[aeiou]/i.test(roleInfo.label) ? "an" : "a") : "a"} {roleInfo?.label.toLowerCase() ?? "new member"}. Every tile can be moved, resized, or hidden later.
            </p>
            <TemplateList cards={list} loading={cards.isLoading} role={role ?? ""} selectedId={selected?.id ?? null} onPick={setTemplateId} />
            <div className="onboard-actions">
              <button type="button" className="btn" onClick={() => setStep("you")}>
                <ArrowLeft size={14} />
                Back
              </button>
              <button type="button" className="btn-primary" data-start-template disabled={!selected || apply.isPending} onClick={() => apply.mutate()}>
                {apply.isPending ? "Setting up…" : selected ? `Start with ${selected.name}` : "Start"}
                <ArrowRight size={14} />
              </button>
            </div>
          </div>
        )}
      </aside>

      <TemplateStage
        card={selected}
        role={role ?? ""}
        kicker={step === "you" ? "A desk you could start with" : "Preview with sample data"}
        empty="Pick what you do. A desk built for it shows up here."
      />
    </div>
  );
}
