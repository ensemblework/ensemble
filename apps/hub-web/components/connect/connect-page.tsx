"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { APPS } from "@/lib/connect/catalog";
import { AUDIENCES, type AudienceId } from "@/lib/connect/prompts";
import { useToast } from "../toast";
import { PageHeader, cx } from "../ui";
import { StatusPill } from "./bits";
import { BridgeKey } from "./bridge-key";
import { AppMark } from "./logos";

export function ConnectPage({ embedded = false }: { embedded?: boolean }) {
  const toast = useToast();
  const bridge = useQuery({
    queryKey: ["connect-bridge"],
    queryFn: api.connectBridge,
    refetchInterval: 20_000,
    staleTime: 10_000,
  });
  const [audience, setAudience] = useState<AudienceId>("student");
  const prompts = AUDIENCES.find((row) => row.id === audience) ?? AUDIENCES[0]!;
  const state = bridge.isLoading ? "loading" : (bridge.data?.state ?? "not_running");

  return (
    <div className={embedded ? "" : "mx-auto max-w-[1040px] px-6 pb-24 pt-8 md:px-10"}>
      {embedded ? (
        <section className="tile section mb-5">
          <h2 className="text-[17px] font-semibold">Apps</h2>
          <p className="mt-1 text-[13px] leading-5 text-muted">
            Let the apps you already use look at your Ensemble. They can read. They cannot change anything.
          </p>
        </section>
      ) : (
      <PageHeader
        title="Connect your apps"
        description="Let the apps you already use look at your Ensemble — tasks, people, meetings, and today’s plan. They can read. They cannot change anything."
      />
      )}
      <div className="mb-6 -mt-3">
        <StatusPill state={state} />
      </div>

      {bridge.isError ? (
        <p className="mb-4 rounded-lg border border-warn/40 bg-panel px-3 py-2 text-[13px] text-muted">{(bridge.error as Error).message}</p>
      ) : null}

      <section className="connect-rise tile rounded-xl bg-panel p-4 md:p-5" aria-labelledby="bridge-key-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 id="bridge-key-title" className="text-[15px] font-semibold tracking-tight">
            Your read-only key
          </h2>
          <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-[11.5px] font-medium text-ink">Read only</span>
        </div>
        <div className="mt-2">
          <BridgeKey tokens={bridge.data?.tokens ?? []} />
        </div>
      </section>

      <h2 className="mb-3 mt-8 text-[13px] font-semibold uppercase tracking-[0.14em] text-faint">Choose an app</h2>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {APPS.map((app, index) => (
          <li key={app.id} className="connect-rise" style={{ animationDelay: `${index * 40}ms` }}>
            <Link
              href={`/connect/${app.id}`}
              className="connect-card tile flex h-full flex-col rounded-xl bg-panel p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <AppMark id={app.id} />
                <span className="text-[11.5px] font-medium text-faint">Guide</span>
              </div>
              <h3 className="mt-3 text-[15px] font-semibold tracking-tight">{app.name}</h3>
              <p className="mt-1 flex-1 text-[13px] leading-5 text-muted">{app.get}</p>
              <span className="btn-primary mt-4 w-fit">Guide me</span>
            </Link>
          </li>
        ))}
      </ul>

      <section className="mt-10" aria-labelledby="ask-title">
        <h2 id="ask-title" className="text-[18px] font-semibold tracking-tight">
          What can I ask?
        </h2>
        <p className="mt-1 max-w-2xl text-[13.5px] leading-5 text-muted">
          Ordinary sentences are enough. Copy one and paste it into the app after you connect. The app looks the answer up in Ensemble and should tell you where it came from.
        </p>
        <div role="tablist" aria-label="Who is asking" className="mt-4 flex flex-wrap gap-1.5">
          {AUDIENCES.map((row) => (
            <button
              key={row.id}
              type="button"
              role="tab"
              aria-selected={audience === row.id}
              className={cx(
                "rounded-full border px-3 py-1 text-[13px]",
                audience === row.id ? "border-accent bg-accent-soft font-medium text-ink" : "border-line text-muted hover:text-ink",
              )}
              onClick={() => setAudience(row.id)}
            >
              {row.label}
            </button>
          ))}
        </div>
        <ul className="mt-3 grid gap-2 md:grid-cols-3" key={audience}>
          {prompts.prompts.map((prompt, index) => (
            <li key={prompt} className="connect-rise" style={{ animationDelay: `${index * 50}ms` }}>
              <button
                type="button"
                className="tile h-full w-full rounded-xl bg-panel p-3 text-left text-[13.5px] leading-5 hover:border-line-strong"
                onClick={() => {
                  void navigator.clipboard.writeText(prompt);
                  toast("Copied. Paste it into your app.", { tone: "ok" });
                }}
              >
                {prompt}
                <span className="mt-2 block text-[12px] font-medium text-accent">Copy question</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
