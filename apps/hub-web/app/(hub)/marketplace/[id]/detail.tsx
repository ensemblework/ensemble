"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { deskIdFromTemplate } from "@/components/desk/desks";
import { DeskMini } from "@/components/desk/mini";
import { api } from "@/lib/api";
import { isBakedParam, useDesktopParam } from "@/lib/desktop-param";
import { emitToast } from "@/lib/toast-bus";

type Payload = {
  applied: boolean;
  template: {
    id: string;
    name: string;
    blurb: string;
    persona: string;
    removes: string[];
    highlights: string[];
    layouts: { today: { placements: Array<{ type: string; size: string }> } };
  };
  diff: {
    modulesOff: string[];
    modulesOn: string[];
    labels: Array<{ key: string; value: string }>;
    widgets: { today: { added: string[]; removed: string[] }; context: { added: string[]; removed: string[] } };
    actAs: { from: string; to: string } | null;
    accent: { from: string; to: string } | null;
    lens: { groupBy: string; kinds: string[] } | null;
    lines?: string[];
  };
};

export function MarketplaceDetail({ id: baked }: { id: string }) {
  const id = useDesktopParam(baked);
  const router = useRouter();
  const toast = emitToast;
  const client = useQueryClient();
  const [wide, setWide] = useState(false);
  const [asked, setAsked] = useState(false);
  const [Preview, setPreview] = useState<ComponentType<{ placements: Array<{ type: string; size: string }> }> | null>(null);
  const [busy, setBusy] = useState(false);
  const diffRef = useRef<HTMLElement>(null);
  const query = useQuery({
    queryKey: ["marketplace", id],
    queryFn: () => apiGet(id),
    enabled: !isBakedParam(id),
    retry: false,
  });
  const history = useQuery({ queryKey: ["template-history"], queryFn: api.templateHistory, staleTime: 15_000 });

  useEffect(() => {
    diffRef.current?.focus();
  }, [query.data?.template.id]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const apply = () => setWide(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (!wide && !asked) return;
    let live = true;
    void import("../preview").then((mod) => {
      if (live) setPreview(() => mod.TemplatePreview);
    });
    return () => {
      live = false;
    };
  }, [wide, asked]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      router.push("/marketplace");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  const data = query.data;
  if (query.isError) {
    return <div className="mx-auto max-w-[820px] px-4 pt-10 text-[14px] text-muted">That template is not in the catalog.</div>;
  }
  if (!data) {
    return <div className="mx-auto max-w-[820px] px-4 pt-10 text-[14px] text-muted">Opening…</div>;
  }
  const { template, diff } = data;

  const apply = async (templateId: string) => {
    setBusy(true);
    try {
      await api.applyTemplate(templateId);
      await client.invalidateQueries({ queryKey: ["shell"] });
      await client.invalidateQueries({ queryKey: ["layout"] });
      await client.invalidateQueries({ queryKey: ["settings"] });
      await client.invalidateQueries({ queryKey: ["template-history"] });
      if (templateId !== "default" && diff.accent) {
        const { publishAppearance, readAppearance } = await import("@/lib/prefs");
        publishAppearance({ ...readAppearance(), accent: diff.accent.to as "indigo", accentCustom: null });
      }
      const name = templateId === "default" ? "Default" : template.name;
      toast(`You're on ${name}`, {
        tone: "ok",
        action: {
          label: "Undo",
          run: () => {
            void api.revertTemplate().then(async () => {
              await client.invalidateQueries({ queryKey: ["shell"] });
              await client.invalidateQueries({ queryKey: ["layout"] });
              await client.invalidateQueries({ queryKey: ["settings"] });
              router.push("/today?applied=1");
            });
          },
        },
      });
      router.push(templateId === "default" ? "/today" : "/today?applied=1");
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto min-w-0 max-w-[820px] px-4 pb-28 pt-8 sm:px-10">
      <a href="/marketplace" className="text-[13px] text-muted hover:text-ink">
        All templates
      </a>
      <div className="mt-3 text-[13px] capitalize text-muted">{template.persona}</div>
      <h1 className="display mt-1 text-[36px] leading-none">{template.name}</h1>
      <p className="mt-2 text-[15px] text-muted">{template.blurb}</p>

      <section ref={diffRef} tabIndex={0} className="mt-6 rounded-xl border border-line p-4 outline-none" aria-label="What will change">
        <h2 className="text-[13px] font-medium uppercase tracking-[0.08em] text-faint">What changes for you</h2>
        <ul className="mt-2 space-y-1.5 text-[14px]">
          {(diff.lines ?? []).map((line) => (
            <li key={line}>{line}</li>
          ))}
          {diff.actAs ? <li>Ensemble speaks as {diff.actAs.to}.</li> : null}
        </ul>
      </section>

      <div className="sticky bottom-0 z-10 mt-6 flex flex-wrap items-center gap-2 border-t border-line bg-bg/95 py-3 md:static md:border-0 md:bg-transparent">
        <button type="button" className="btn-primary w-full md:w-auto" disabled={busy || data.applied} onClick={() => void apply(template.id)}>
          {data.applied ? "Applied" : busy ? "Applying…" : `Apply ${template.name}`}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void apply("default")}>
          Use Default
        </button>
        {history.data?.history.length ? (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void api.revertTemplate().then(async () => {
                await client.invalidateQueries({ queryKey: ["shell"] });
                await client.invalidateQueries({ queryKey: ["layout"] });
                await client.invalidateQueries({ queryKey: ["settings"] });
                router.push("/today?applied=1");
              }).catch((error: Error) => {
                toast(error.message, { tone: "error" });
                setBusy(false);
              });
            }}
          >
            Revert to previous
          </button>
        ) : null}
        {wide || asked ? null : (
          <button type="button" className="btn" onClick={() => setAsked(true)}>
            Preview
          </button>
        )}
      </div>
      {wide || asked ? (
        <div className="mt-4" aria-label="Preview">
          <p className="mb-2 text-[12.5px] text-muted">Sample preview · not your live desk</p>
          {deskIdFromTemplate(template.id) ? (
            <DeskMini deskId={deskIdFromTemplate(template.id)!} width={790} height={520} state="populated" />
          ) : Preview ? (
            <Preview placements={template.layouts.today.placements} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

async function apiGet(id: string): Promise<Payload> {
  const response = await fetch(`/api/marketplace/templates/${id}`, { credentials: "include" });
  if (!response.ok) throw new Error("Unknown template.");
  return response.json() as Promise<Payload>;
}
