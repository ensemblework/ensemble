"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQuery } from "@tanstack/react-query";
import { ExternalLink, KeyRound, Link2, Wrench } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import type { CatalogEntry } from "@/lib/api-connectors";
import { AppSetup } from "@/components/settings/setup";
import { Spinner, cx } from "../ui";
import { browser } from "./browser";
import { McpTokenPrompt, useMcpConnect, type McpConnectExtra } from "./mcp-connect";

/** The short name people use for the vendor. */
function brandOf(entry: Pick<CatalogEntry, "name" | "vendor">): string {
  const first = entry.name.split(" ")[0];
  return entry.vendor.split(" ")[0] === first && first ? first : entry.vendor;
}

/** "Set up once" for the registered client a vendor's MCP server needs; nothing for everyone else. */
export function McpClientSetup({ app }: { app: string }) {
  const apps = useQuery({ queryKey: ["connector-apps"], queryFn: api.connectorApps, retry: false });
  const row = apps.data?.apps.find((candidate) => (candidate.provider as string) === app);
  if (!row || !apps.data?.canEdit) return null;
  return <AppSetup app={row} canEdit />;
}

/**
 * How a person connects a vendor's MCP server from its detail page: address
 * fields (Grafana's stack), a pasted token, their organisation's own client,
 * the operator's registered client, or their existing connection to the app.
 */
export function McpConnectWay({ entry, primary }: { entry: CatalogEntry; primary: boolean }) {
  const mcp = entry.mcp!;
  const brand = brandOf(entry);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [tokenOpen, setTokenOpen] = useState(Boolean(mcp.token?.only));
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const connect = useMcpConnect({ target: () => ({ serverId: entry.id, returnTo: browser.returnTo(entry.id) }), label: entry.name });
  const withFields = (extra: McpConnectExtra = {}): McpConnectExtra => (mcp.fields?.length ? { ...extra, fields } : extra);
  const fieldsReady = (mcp.fields ?? []).every((field) => (fields[field.name] ?? "").trim().length > 0);
  const button = primary ? "btn-primary" : "btn";

  if (mcp.client && entry.state.mcpReady === false) {
    return (
      <div className="mt-2 space-y-2 text-[12.5px] text-muted" data-testid="mcp-not-set-up">
        <p>Sign in with {brand} is coming soon. You can use another connection option when available.</p>
        <McpClientSetup app={mcp.client.app} />
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      {mcp.fields?.map((field) => (
        <label key={field.name} className="block text-[12.5px] font-medium">
          {field.label}
          <input
            name={field.name}
            value={fields[field.name] ?? ""}
            placeholder={field.placeholder}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setFields((current) => ({ ...current, [field.name]: event.target.value }))}
            className="field mt-1 w-full max-w-sm font-normal"
          />
          {field.help ? <span className="mt-0.5 block text-[12px] font-normal text-muted">{field.help}</span> : null}
        </label>
      ))}
      {mcp.ownClient ? (
        <form
          className="space-y-2 rounded-lg bg-raised p-3"
          data-testid="mcp-own-client"
          onSubmit={(event) => {
            event.preventDefault();
            if (clientId.trim() && !connect.pending) connect.connect(withFields({ clientId: clientId.trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) }));
          }}
        >
          <p className="text-[12.5px] text-muted">{mcp.ownClient.hint}</p>
          <RedirectUri />
          {mcp.ownClient.url ? (
            <a href={mcp.ownClient.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline">
              How to create it <ExternalLink size={11} />
            </a>
          ) : null}
          <input value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="Client ID (consumer key)" autoComplete="off" spellCheck={false} className="field w-full font-mono" />
          <input value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} placeholder="Client secret" type="password" autoComplete="off" className="field w-full font-mono" />
          <div className="flex justify-end">
            <button type="submit" className={button} disabled={!clientId.trim() || connect.pending}>
              {connect.pending ? <Spinner size={12} /> : <Wrench size={12} />} Connect tools
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {mcp.connection ? (
            entry.state.connected ? (
              <button type="button" className={button} disabled={connect.pending} onClick={() => connect.connect(withFields({ useConnection: true }))}>
                {connect.pending ? <Spinner size={12} /> : <Link2 size={12} />} Use your {brand} connection
              </button>
            ) : (
              <span className="text-[12.5px] text-muted">Connect {brand} above first; its tools then use the same connection.</span>
            )
          ) : mcp.token?.only ? null : (
            <button type="button" className={button} disabled={connect.pending || !fieldsReady} onClick={() => connect.connect(withFields())}>
              {connect.pending ? <Spinner size={12} /> : <Wrench size={12} />} Connect tools
            </button>
          )}
          {mcp.token && !tokenOpen ? (
            <button type="button" className="btn-ghost text-[12.5px]" onClick={() => setTokenOpen(true)}>
              <KeyRound size={12} /> Paste {mcp.token.label.toLowerCase().startsWith(brand.toLowerCase()) ? "a token" : `a ${mcp.token.label}`} instead
            </button>
          ) : null}
        </div>
      )}
      {mcp.token && tokenOpen ? (
        <form
          className="space-y-2 rounded-lg bg-raised p-3"
          data-testid="mcp-token-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (token.trim().length >= 8 && fieldsReady && !connect.pending) connect.connect(withFields({ token: token.trim() }));
          }}
        >
          {mcp.token.hint ? <p className="text-[12.5px] text-muted">{mcp.token.hint}</p> : null}
          {mcp.token.url ? (
            <a href={mcp.token.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline">
              Where to get it <ExternalLink size={11} />
            </a>
          ) : null}
          <label className="block text-[12.5px] font-medium">
            {mcp.token.label}
            <input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(event) => setToken(event.target.value)} className="field mt-1 w-full font-mono" />
          </label>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="mr-auto text-[12px] text-muted">Sent to {brand} as a bearer token and stored encrypted.</span>
            {mcp.token.only ? null : (
              <button type="button" className="btn-ghost" onClick={() => setTokenOpen(false)}>
                Cancel
              </button>
            )}
            <button type="submit" className={cx(mcp.token.only ? button : "btn-primary")} disabled={token.trim().length < 8 || !fieldsReady || connect.pending}>
              {connect.pending ? <Spinner size={12} /> : null} Connect with token
            </button>
          </div>
        </form>
      ) : null}
      {connect.problem ? (
        connect.asksForToken ? (
          <McpTokenPrompt
            label={entry.name}
            problem={connect.problem}
            pending={connect.pending}
            onSubmit={(value) => connect.connect(withFields({ token: value }))}
            onCancel={connect.clear}
          />
        ) : (
          <p role="alert" className="text-[12.5px] text-danger">
            {connect.problem.message}
          </p>
        )
      ) : null}
    </div>
  );
}

/** The MCP callback a vendor-side app must allow. */
function RedirectUri() {
  const apps = useQuery({ queryKey: ["connector-apps"], queryFn: api.connectorApps, retry: false });
  const uri = apps.data?.mcpRedirectUri;
  if (!uri) return null;
  return (
    <div className="rounded-md bg-panel px-2 py-1.5 font-mono text-[12px]" title="Redirect URI">
      <span className="block truncate">{uri}</span>
    </div>
  );
}
