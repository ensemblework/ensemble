"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { MCP_OAUTH_REQUEST_PATTERN } from "@ensemble/shared-types";
import { api, ApiError } from "@/lib/api";
import { EnsembleLogo } from "./brand/Logo";
import { InfoTip, SettingRow, Spinner, Toggle } from "./ui";

type Choice = { spaceId?: string; canWrite?: boolean; canUseApps?: boolean };

export function McpConsent({ initialRequest }: { initialRequest?: string }) {
  const [request, setRequest] = useState(initialRequest ?? "");
  const [choice, setChoice] = useState<Choice>({});
  const [redirecting, setRedirecting] = useState(false);
  useEffect(() => {
    setRequest(initialRequest ?? new URLSearchParams(window.location.search).get("request") ?? "");
    setChoice({});
  }, [initialRequest]);
  const valid = MCP_OAUTH_REQUEST_PATTERN.test(request);
  const consent = useQuery({
    queryKey: ["mcp-oauth-consent", request],
    queryFn: () => api.mcpOAuthConsent(request),
    enabled: valid, retry: false, staleTime: Infinity,
  });
  const data = consent.data;
  const canWrite = Boolean(data?.canWrite && choice.canWrite !== false);
  const canUseApps = Boolean(data?.canUseApps && choice.canUseApps !== false);
  const spaceId = choice.spaceId ?? data?.spaces[0]?.id;
  const decide = useMutation({
    mutationFn: async (decision: "allow" | "deny") => {
      if (!data) throw new Error("Reload this sign-in request before continuing.");
      return api.decideMcpOAuth({ request, csrf: data.csrf, decision, spaceId, canWrite, canUseApps });
    },
    onSuccess: result => {
      setRedirecting(true);
      window.location.href = result.redirect;
    },
  });
  const busy = decide.isPending || redirecting;
  const error = decide.error ?? consent.error;
  const login = `/login?next=${encodeURIComponent(`/oauth?request=${request}`)}`;

  return (
    <main className="min-h-screen bg-bg px-5 py-10 text-ink">
      <div className="mx-auto max-w-[580px]">
        <Link href="/" aria-label="Ensemble home" className="inline-flex min-h-11 items-center gap-2">
          <EnsembleLogo size={24} /><span className="text-[15px] font-semibold">Ensemble</span>
        </Link>
        <section className="tile mt-5 rounded-2xl bg-panel p-5 md:p-7" aria-labelledby="mcp-consent-title">
          <h1 id="mcp-consent-title" className="display text-[28px] leading-tight">Connect an app</h1>
          {!valid ? (
            <p className="mt-4 text-[14px] text-muted" role="alert">Start this connection from the app you want to use.</p>
          ) : consent.isPending ? (
            <div className="mt-5 flex items-center gap-2 text-[14px] text-muted" role="status"><Spinner size={14} /> Loading request</div>
          ) : null}
          {error ? (
            <div className="mt-4 rounded-lg border border-warn/40 p-3 text-[14px]" role="alert">
              {error.message}
              {error instanceof ApiError && (error.status === 401 || error.status === 403) ? (
                <Link href={login} className="btn mt-3 min-h-11">Sign in</Link>
              ) : (
                <button type="button" className="btn mt-3 min-h-11" onClick={() => { decide.reset(); void consent.refetch(); }}>Reload request</button>
              )}
            </div>
          ) : null}
          {data ? (
            <>
              <div className="mt-5 rounded-xl border border-line bg-bg/60 p-4">
                <h2 className="break-words text-[18px] font-semibold">{data.clientName}</h2>
                <dl className="mt-3 space-y-2 text-[13.5px]">
                  <div><dt className="text-muted">Your account</dt><dd className="break-all">{data.accountEmail}</dd></div>
                  <div><dt className="text-muted">Returns to</dt><dd className="break-all font-mono text-[13px]">{data.clientOrigin}</dd></div>
                  {data.clientMetadataOrigin ? <div><dt className="text-muted">App metadata</dt><dd className="break-all font-mono text-[13px]">{data.clientMetadataOrigin}</dd></div> : null}
                </dl>
              </div>
              <div className="mt-3 flex items-center gap-1.5 text-[13px] text-muted">
                Approve only a connection you started.
                <InfoTip text="The app chooses its name. Check the domains above before allowing access. This does not verify or endorse the app." label="About this app's identity" />
              </div>
              <div className="mt-4 divide-y divide-line">
                <SettingRow title="Read your work" info="Reads records and files in the spaces you own. Shared spaces are not available to MCP connections.">
                  <Toggle checked disabled onChange={() => {}} label="Read your work" />
                </SettingRow>
                {data.canWrite ? (
                  <SettingRow title="Make changes" info="Allows the existing Context Bridge record and file-upload actions. Changes in Ensemble use its normal Undo rules. Turn this off for read-only access.">
                    <Toggle checked={canWrite} disabled={busy} onChange={value => setChoice(current => ({ ...current, canWrite: value }))} label="Allow this app to make changes" />
                  </SettingRow>
                ) : null}
                {data.canUseApps ? (
                  <SettingRow title="Use connected apps" info="Uses your connected apps through Ensemble. Reading needs this permission; changing an app also needs Make changes. Your app credentials are not shared with this client.">
                    <Toggle checked={canUseApps} disabled={busy} onChange={value => setChoice(current => ({ ...current, canUseApps: value }))} label="Allow use of your connected apps" />
                  </SettingRow>
                ) : null}
                <SettingRow title={<label htmlFor="mcp-start-space">Start in</label>} info="This is the default space. The app can name any other space you own; it cannot use spaces shared with you.">
                  {data.spaces.length > 1 ? (
                    <select id="mcp-start-space" className="field w-40" value={spaceId} disabled={busy} onChange={event => setChoice(current => ({ ...current, spaceId: event.target.value }))}>
                      {data.spaces.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
                    </select>
                  ) : <span className="text-[13.5px]">{data.spaces[0]?.name}</span>}
                </SettingRow>
              </div>
              <div className="mt-6 flex flex-wrap justify-end gap-2">
                <button type="button" className="btn min-h-11" disabled={busy} onClick={() => decide.mutate("deny")}>Deny</button>
                <button type="button" className="btn-primary min-h-11" disabled={busy || !spaceId} onClick={() => decide.mutate("allow")}>
                  {busy ? <Spinner size={14} /> : null}{redirecting ? "Returning to app" : decide.isPending ? "Connecting" : "Allow"}
                </button>
              </div>
            </>
          ) : null}
        </section>
      </div>
    </main>
  );
}
