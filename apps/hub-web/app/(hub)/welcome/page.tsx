"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect } from "react";
import type { Settings } from "@ensemble/shared-types";
import { ConnectionsPanel, EditorsSection, ModelKeysCard } from "@/components/settings/setup";
import { useToast } from "@/components/toast";
import { PageHeader, SectionCard, Spinner } from "@/components/ui";
import { api } from "@/lib/api";

/** First-run setup for someone who is not a developer: three cards, all optional. */
export default function WelcomePage() {
  const client = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const failed = params.get("connectError");
    if (connected === "google") toast("Signed in with Google. Gmail and Calendar are on.", { tone: "ok" });
    else if (connected) toast(`${connected} connected.`, { tone: "ok" });
    if (failed) toast(failed, { tone: "error" });
    if (connected || failed) window.history.replaceState(null, "", "/welcome");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.saveSettings(patch),
    onSuccess: (result) => client.setQueryData(["settings"], result),
  });
  if (!settings.data) return <div className="p-10"><Spinner /></div>;
  const value: Settings = settings.data.settings;
  return (
    <div className="mx-auto max-w-[820px] px-10 pb-24 pt-8">
      <PageHeader
        title={`Welcome${me.data?.user.name ? `, ${me.data.user.name.split(" ")[0]}` : ""}`}
        description="Three optional steps. Everything here can be changed later in Settings."
        actions={
          <Link href="/today" className="btn-primary">
            Go to Today
          </Link>
        }
      />
      <div className="space-y-5">
        <SectionCard title="1 · Give Ensemble a model" description="The assistant and the inbox triage need one API key. Google Gemini is the cheapest way to start.">
          <ModelKeysCard compact />
        </SectionCard>
        <SectionCard title="2 · Connect your accounts" description="Sign in with Google to turn on Gmail and Calendar. Ensemble only reads them, then turns asks into proposed todos on Today.">
          <ConnectionsPanel settings={value} patch={(patch) => save.mutate(patch)} returnTo="/welcome" />
        </SectionCard>
        <EditorsSection />
      </div>
    </div>
  );
}
