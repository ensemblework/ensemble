"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { useEffect, useState } from "react";
import { DESK_IDS, DESKS, MARKET_ID } from "@/components/desk/desks";
import { useToast } from "@/components/toast";
import { api, HUB_API } from "@/lib/api";
import { clearBrowserTabSession } from "@/lib/tab-session";
import { SectionCard } from "../ui";

export function AccountSection() {
  const toast = useToast();
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const error = query.get("error");
    if (error) toast(error, { tone: "error" });
    if (query.get("linked")) toast("Login method linked.", { tone: "ok" });
    if (error || query.get("linked")) window.history.replaceState(null, "", window.location.pathname);
  }, [toast]);
  const client = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell });
  const devTools = shell.data?.devTools === true;
  const history = useQuery({ queryKey: ["template-history"], queryFn: api.templateHistory, enabled: devTools });
  const revert = useMutation({
    mutationFn: () => api.revertTemplate(),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["shell"] });
      await client.invalidateQueries({ queryKey: ["layout"] });
      await client.invalidateQueries({ queryKey: ["settings"] });
      await client.invalidateQueries({ queryKey: ["template-history"] });
      toast("Reverted. Your tasks stay.", { tone: "ok" });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const useDefault = useMutation({
    mutationFn: () => api.applyTemplate("default"),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["shell"] });
      await client.invalidateQueries({ queryKey: ["layout"] });
      await client.invalidateQueries({ queryKey: ["settings"] });
      await client.invalidateQueries({ queryKey: ["template-history"] });
      toast("Default is on. Your tasks stay.", { tone: "ok" });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const [name, setName] = useState<string | null>(null);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const save = useMutation({
    mutationFn: (data: { name?: string; password?: string; current?: string }) => api.updateMe(data),
    onSuccess: async () => {
      toast("Saved.", { tone: "ok" });
      setCurrent("");
      setPassword("");
      await client.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      clearBrowserTabSession();
      window.location.href = "/login";
    },
  });
  const identities = useQuery({ queryKey: ["auth-identities"], queryFn: api.identities, enabled: me.data?.via === "session" });
  const unlink = useMutation({
    mutationFn: (provider: string) => api.unlinkIdentity(provider, current || undefined),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["auth-identities"] }); toast("Login method removed.", { tone: "ok" }); },
    onError: (error) => toast(error.message, { tone: "error" }),
  });
  const exported = useMutation({
    mutationFn: api.exportAccount,
    onSuccess: (data) => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "ensemble-data.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    onError: (error) => toast(error.message, { tone: "error" }),
  });
  const deletion = useMutation({
    mutationFn: () => api.deleteAccount(current || undefined),
    onSuccess: () => { clearBrowserTabSession(); client.clear(); window.location.href = "/signup"; },
    onError: (error) => toast(error.message, { tone: "error" }),
  });
  if (!me.data) return null;
  const local = me.data.via === "bypass" || me.data.via === "desktop";
  return (
    <SectionCard
      title="Account"
      description={local ? "No-login mode (ENSEMBLE_DEV_AUTH_BYPASS). Create an account to turn sign-in on; your existing data comes with you." : `Signed in as ${me.data.user.email}.`}
      actions={
        local ? (
          <a className="btn-primary" href="/signup">
            Create account
          </a>
        ) : (
          <button type="button" className="btn" onClick={() => logout.mutate()}>
            <LogOut size={12} /> Sign out
          </button>
        )
      }
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line px-3 py-2.5">
        <div>
          <div className="text-[13px] font-medium">{shell.data?.templateName ?? "Default"}</div>
          <p className="text-[12.5px] text-muted">The layout and modules on this account. Switching back does not delete tasks.</p>
        </div>
        {devTools ? (
          <button
            type="button"
            className="btn"
            disabled={useDefault.isPending || !shell.data?.activeTemplateId || shell.data.activeTemplateId === "default"}
            onClick={() => useDefault.mutate()}
          >
            Use Default
          </button>
        ) : null}
      </div>
      {devTools && history.data?.history.length ? (
        <ul className="mb-4 divide-y divide-line rounded-xl border border-line">
          {history.data.history.map((row, index) => (
            <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
              <span>
                {row.name}
                <span className="ml-2 text-[12px] text-muted">{new Date(row.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
              </span>
              {index === 0 ? (
                <button type="button" className="btn" disabled={revert.isPending} onClick={() => revert.mutate()}>
                  Revert
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {devTools ? (
        <div id="developer" className="mb-4 scroll-mt-6">
          <div className="mb-2 text-[13px] font-medium">Developer · switch desk</div>
          <div className="flex flex-wrap gap-1.5">
            {DESK_IDS.map((id) => (
              <button
                key={id}
                type="button"
                className="btn"
                onClick={() => {
                  void api.applyTemplate(MARKET_ID[id]).then(() => {
                    window.location.href = "/today?apply=1";
                  });
                }}
              >
                {DESKS[id].name}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {local ? null : (
        <div className="grid grid-cols-2 gap-3">
          <label className="text-[13px] font-medium">
            Name
            <input
              value={name ?? me.data.user.name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => name !== null && name !== me.data!.user.name && save.mutate({ name })}
              className="field mt-1.5 w-full"
            />
          </label>
          <div className="text-[13px] font-medium">
            {me.data.user.hasPassword === false ? "Add a password" : "Change password"}
            <div className="mt-1.5 flex gap-2">
              {me.data.user.hasPassword !== false ? <input type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} placeholder="Current" className="field w-full" /> : null}
              <input type="password" autoComplete="new-password" maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="New (8+)" className="field w-full" />
              <button type="button" className="btn" disabled={save.isPending || password.length < 8 || (me.data.user.hasPassword !== false && !current)} onClick={() => save.mutate({ password, current: current || undefined })}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
      {!local ? (
        <div className="mt-5 space-y-4">
          <div>
            <h3 className="text-[13px] font-medium">Linked login methods</h3>
            <p className="mt-1 text-[12px] text-muted">Login does not connect your mail or repositories. Removing a method or adding a password may require signing in again.</p>
            {identities.error ? <p role="alert" className="mt-2 text-[13px] text-muted">{identities.error.message}</p> : null}
            <div className="mt-2 flex flex-wrap gap-2">
              {identities.data?.providers.map((provider) => {
                const linked = identities.data.identities.some((identity) => identity.provider === provider);
                const label = provider === "github" ? "GitHub" : provider === "google" ? "Google" : "Microsoft";
                return linked ? (
                  <button key={provider} type="button" className="btn" disabled={unlink.isPending || (!me.data.user.hasPassword && identities.data.identities.length <= 1)} onClick={() => unlink.mutate(provider)}>Unlink {label}</button>
                ) : <a key={provider} href={`${HUB_API}/api/auth/oauth/${provider}/start?link=1`} className="btn">Link {label}</a>;
              })}
            </div>
          </div>
          <div className="border-t border-line pt-4">
            <button type="button" className="btn" disabled={exported.isPending} onClick={() => exported.mutate()}>{exported.isPending ? "Exporting..." : "Export account data (JSON)"}</button>
            <p className="mt-2 text-[12px] text-muted">Exports your data, not API tokens, connector secrets, or model keys.</p>
          </div>
          <div className="border-t border-line pt-4">
            <h3 className="text-[13px] font-medium">Delete account</h3>
            <p className="mt-1 text-[12px] text-muted">Stop active agent runs first. This permanently removes hosted account data and revokes connected devices. It does not delete files on your computer.</p>
            <label className="mt-2 block text-[12px] text-muted">Type DELETE to confirm
              <input className="field mt-1 w-full" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" />
            </label>
            <button type="button" className="btn mt-2" disabled={confirmation !== "DELETE" || deletion.isPending} onClick={() => deletion.mutate()}>
              {deletion.isPending ? "Deleting..." : "Permanently delete account"}
            </button>
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}
