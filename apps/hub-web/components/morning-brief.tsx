"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useSpaceAccess } from "@/lib/access";
import { Dialog, PageHeader } from "./ui";

function BriefPreferences({ onSaved }: { onSaved?: () => void }) {
  const client = useQueryClient();
  const [instructions, setInstructions] = useState("");
  const save = useMutation({
    mutationFn: () => api.saveMorningBriefSkill(instructions),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["morning-brief-skill"] });
      void client.invalidateQueries({ queryKey: ["skills"] });
      onSaved?.();
    },
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <p className="text-[13px] text-muted">
        Describe the sections, length, tone and priorities you want each
        morning. This becomes your Morning brief skill, which you can edit and
        test in Skills.
      </p>
      <label className="mt-3 block text-[13px]">
        How should your brief look?
        <textarea
          className="field mt-1 min-h-32 w-full"
          value={instructions}
          maxLength={20_000}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="Start with my three priorities, then meetings and deadlines. Keep it under 200 words."
        />
      </label>
      <button
        className="btn-primary mt-3"
        disabled={!instructions.trim() || save.isPending}
      >
        {save.isPending ? "Saving…" : "Save my morning brief skill"}
      </button>
      {save.error ? (
        <p role="alert" className="mt-2 text-danger">
          {save.error.message}
        </p>
      ) : null}
      {save.isSuccess ? (
        <p role="status" className="mt-2 text-muted">
          Saved. Future briefs use these preferences.
        </p>
      ) : null}
    </form>
  );
}

/** Offer personalization when the first brief is delivered, including when it arrived while away. */
export function MorningBriefPrompt() {
  const access = useSpaceAccess();
  const view = useQuery({
    queryKey: ["morning-brief-skill"],
    queryFn: api.morningBriefSkill,
    enabled: access.ready && !access.guest,
    refetchInterval: 60_000,
  });
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const requested = useRef(false);
  const claim = useMutation({
    mutationFn: () => api.morningBriefPrompt("show"),
    onSuccess: result => {
      setOpen(result.show);
      client.setQueryData(["morning-brief-skill"], (current: Awaited<ReturnType<typeof api.morningBriefSkill>> | undefined) => current ? { ...current, customize: false } : current);
    },
    onError: () => { requested.current = false; },
  });
  useEffect(() => {
    if (!view.data?.customize || requested.current) return;
    requested.current = true;
    claim.mutate();
  }, [view.data?.customize]);
  const close = () => {
    setOpen(false);
    void api.morningBriefPrompt("dismiss").catch(() => undefined);
  };
  return (
    <Dialog
      open={open}
      title="Make your morning brief yours"
      onClose={close}
    >
      <div className="p-4">
        <BriefPreferences onSaved={() => setOpen(false)} />
        <Link
          className="mt-3 block text-[13px] text-accent"
          href="/morning-brief"
          onClick={close}
        >
          Read your first brief
        </Link>
      </div>
    </Dialog>
  );
}

export function MorningBriefPage() {
  const view = useQuery({
    queryKey: ["morning-brief-skill"],
    queryFn: api.morningBriefSkill,
  });
  const preview = useMutation({
    mutationFn: () => api.testSkill(view.data!.skill.id),
  });
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <PageHeader
        title="Morning brief"
        description="Your day, prepared the way you like it."
      />
      {view.isLoading ? <p>Loading…</p> : null}
      {view.error ? <p role="alert">{view.error.message}</p> : null}
      {view.data ? (
        <>
          <article className="tile mb-6 whitespace-pre-wrap rounded-xl p-5 text-[14px]">
            {view.data.notification?.body ??
              "Your first brief arrives the morning after signup, at the time set in Settings → Notifications."}
          </article>
          <BriefPreferences />
          <div className="mt-5 flex gap-3">
            <Link className="btn" href={`/skills?skill=${view.data.skill.id}`}>
              Edit in Skills
            </Link>
            <button
              type="button"
              className="btn"
              disabled={preview.isPending}
              onClick={() => preview.mutate()}
            >
              {preview.isPending ? "Generating…" : "Test my brief"}
            </button>
          </div>
          {preview.error ? (
            <p role="alert" className="mt-2 text-danger">
              {preview.error.message}
            </p>
          ) : null}
          {preview.data ? (
            <article className="tile mt-4 whitespace-pre-wrap rounded-xl p-5 text-[14px]">
              {preview.data.body}
            </article>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
