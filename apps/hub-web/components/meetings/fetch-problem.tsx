"use client";

import { catalogEntry } from "@ensemble/shared-types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ClipboardPaste, ExternalLink, KeyRound, Mail, Upload } from "lucide-react";
import { connectorsApi } from "@/lib/api-connectors";
import { MEETING_QUERY, meetingsApi, type MeetingProblem, type ProblemAction } from "@/lib/api-meetings";
import { useToast } from "../toast";

const RETURN = "/meetings";

/**
 * Connect an app, or switch on the product a transcript needs, then come back to Meeting notes.
 * Suites already connected switch the product on and approve it; others sign in with their defaults
 * plus that product.
 */
export function useConnectApp() {
  const toast = useToast();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ connector, product }: { connector: string; product: string | null }) => {
      const entry = catalogEntry(connector);
      if (!entry?.provider) throw new Error("This app can't be connected here.");
      const sources = await client.fetchQuery({ queryKey: MEETING_QUERY.sources, queryFn: meetingsApi.sources, staleTime: 5_000 });
      const connected = sources.apps.some((app) => app.connector === connector && app.state !== "not_connected");
      if (connected && product) {
        const result = await connectorsApi.setProducts(connector, { [product]: true }, RETURN);
        if ("reconnect" in result) return { url: result.url };
        return { url: null };
      }
      const defaults = (entry.products ?? []).filter((row) => row.defaultOn).map((row) => row.id);
      const products = entry.products?.length ? [...new Set([...defaults, ...(product ? [product] : [])])] : undefined;
      return connectorsApi.start(entry.provider, { products, returnTo: RETURN });
    },
    onSuccess: (result) => {
      if (result.url) window.location.assign(result.url);
      else {
        toast("Switched on. Try again.");
        void client.invalidateQueries({ queryKey: MEETING_QUERY.sources });
      }
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
}

function mailto(action: Extract<ProblemAction, { kind: "ask_organizer" }>): string {
  return `mailto:${action.email ? encodeURIComponent(action.email) : ""}?subject=${encodeURIComponent(action.subject)}&body=${encodeURIComponent(action.body)}`;
}

/** Why a transcript can't be fetched, and the next steps that still work. */
export function FetchProblem({ problem, onPaste, onUpload, compact = false }: { problem: MeetingProblem; onPaste: () => void; onUpload: () => void; compact?: boolean }) {
  const connect = useConnectApp();
  return (
    <div className="fetch-problem" role="status" data-code={problem.code} data-compact={compact || undefined}>
      <AlertCircle size={16} className="fetch-problem-icon" aria-hidden />
      <div className="min-w-0">
        <p className="fetch-problem-title">{problem.title}</p>
        <p className="fetch-problem-detail">{problem.detail}</p>
        <div className="fetch-problem-actions">
          {problem.actions.map((action, index) => {
            const primary = index === 0;
            const cls = primary ? "btn-primary" : "btn";
            switch (action.kind) {
              case "connect":
                return (
                  <button key={index} type="button" className={cls} disabled={connect.isPending} onClick={() => connect.mutate({ connector: action.connector, product: action.product })}>
                    <KeyRound size={14} aria-hidden />
                    {connect.isPending ? "Opening sign-in…" : action.label}
                  </button>
                );
              case "open":
                return (
                  <a key={index} className={cls} href={action.url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink size={14} aria-hidden />
                    {action.label}
                  </a>
                );
              case "ask_organizer":
                return (
                  <a key={index} className={cls} href={mailto(action)}>
                    <Mail size={14} aria-hidden />
                    {action.label}
                  </a>
                );
              case "paste":
                return (
                  <button key={index} type="button" className={cls} onClick={onPaste}>
                    <ClipboardPaste size={14} aria-hidden />
                    {action.label}
                  </button>
                );
              case "upload":
                return (
                  <button key={index} type="button" className={cls} onClick={onUpload}>
                    <Upload size={14} aria-hidden />
                    {action.label}
                  </button>
                );
              default:
                return null;
            }
          })}
        </div>
      </div>
    </div>
  );
}
