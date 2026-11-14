"use client";

import { Copy, Unplug } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { relative } from "@/lib/format";
import { InfoTip, Spinner } from "../ui";
import { useToast } from "../toast";

export function OAuthConnections({ url }: { url: string }) {
  const client = useQueryClient();
  const toast = useToast();
  const connections = useQuery({ queryKey: ["mcp-oauth-connections"], queryFn: api.mcpOAuthConnections, retry: false });
  const disconnect = useMutation({
    mutationFn: (id: string) => {
      if (!connections.data) throw new Error("Reload your app connections before disconnecting one.");
      return api.disconnectMcpOAuth(id, connections.data.csrf);
    },
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["mcp-oauth-connections"] }); },
    onError: error => toast(error.message, { tone: "error" }),
  });

  return (
    <section className="tile mb-5 rounded-xl bg-panel p-4 md:p-5" aria-labelledby="oauth-apps-title">
      <div className="flex items-center gap-1.5">
        <h2 id="oauth-apps-title" className="text-[15px] font-semibold">AI apps and automations</h2>
        <InfoTip text="Add this MCP URL from your app, then sign in to Ensemble. OAuth apps choose read-only or change access during consent. Editors can still use their existing CLI or key configuration." />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-bg/60 px-3 py-2">
        <code className="break-all text-[13px]">{url}</code>
        <button type="button" className="btn min-h-11" onClick={() => {
          void navigator.clipboard.writeText(url).catch(() => toast("Could not copy the MCP URL. Select it and copy it manually.", { tone: "error" }));
        }}><Copy size={14} /> Copy URL</button>
      </div>
      <a href="https://docs.ensemblework.com/context_bridge/" className="mt-2 inline-flex min-h-11 items-center text-[13px] text-accent" target="_blank" rel="noreferrer">App setup guide</a>
      {connections.isPending ? <div role="status" className="mt-2 flex items-center gap-2 text-[13px] text-muted"><Spinner size={12} /> Loading app connections</div> : null}
      {connections.isError ? (
        <div className="mt-2 text-[13px]" role="alert">
          {connections.error.message}
          <button type="button" className="btn ml-2 min-h-11" onClick={() => void connections.refetch()}>Reload</button>
        </div>
      ) : null}
      {connections.data?.connections.length === 0 ? <p className="mt-2 text-[13px] text-muted">No AI apps connected.</p> : null}
      {connections.data?.connections.length ? (
        <ul className="mt-3 divide-y divide-line">
          {connections.data.connections.map(connection => (
            <li key={connection.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="break-words text-[13.5px] font-medium">{connection.name}</div>
                <div className="text-[12.5px] text-muted">{connection.space} · {connection.canWrite ? "Changes allowed" : "Read only"}{connection.canUseApps ? " · Connected apps" : ""}</div>
                <div className="text-[12px] text-faint">{connection.lastUsedAt ? `Used ${relative(connection.lastUsedAt)}` : "Not used yet"}</div>
              </div>
              <button type="button" className="btn min-h-11" disabled={disconnect.isPending} onClick={() => disconnect.mutate(connection.id)}>
                <Unplug size={14} /> Disconnect
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
