"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SignOutButton } from "../account/sign-out";
import { useCallback, useEffect, useRef, useState } from "react";
import { PASSWORD_RULE, passwordProblem } from "@ensemble/shared-types";
import { DESK_IDS, DESKS, MARKET_ID } from "@/components/desk/desks";
import { PasswordField } from "@/components/password-field";
import { ProfileForm } from "@/components/profile-form";
import { useToast } from "@/components/toast";
import { api, HUB_API } from "@/lib/api";
import { clearBrowserTabSession } from "@/lib/tab-session";
import { Modal } from "./modal";
import { BrandLogo } from "../connectors/brand-logo";
import { InfoTip, SectionCard } from "../ui";
import { hasUnsaved, markUnsaved } from "./unsaved";

export function AccountSection() {
  const toast = useToast();
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const error = query.get("error");
    if (error) toast(error, { tone: "error" });
    if (query.get("linked")) toast("Login method linked.", { tone: "ok" });
    if (error || query.get("linked")) {
      query.delete("error");
      query.delete("linked");
      const rest = query.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
    }
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
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [repeatError, setRepeatError] = useState<string | null>(null);
  const [securityPassword,setSecurityPassword]=useState("");
  const [unlinking,setUnlinking]=useState<string|null>(null);
  // Mutation state reaches the button a render later; these refuse a second click in between.
  const profileBusy = useRef(false);
  const passwordBusy = useRef(false);
  const profileDirty = useCallback((dirty: boolean) => markUnsaved("profile", dirty), []);
  useEffect(() => markUnsaved("password", Boolean(password || repeat)), [password, repeat]);
  useEffect(
    () => () => {
      markUnsaved("profile", false);
      markUnsaved("password", false);
    },
    [],
  );
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (hasUnsaved()) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const profileSave = useMutation({
    mutationFn: api.updateProfile,
    onSuccess: async () => {
      toast("Profile saved.", { tone: "ok" });
      await client.invalidateQueries({ queryKey: ["me"] });
      await client.invalidateQueries({ queryKey: ["shell"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const save = useMutation({
    mutationFn: (data: { name?: string; password?: string; current?: string }) => api.updateMe(data),
    onSuccess: async () => {
      toast("Password saved.", { tone: "ok" });
      setPasswordOpen(false);
      setCurrent("");
      setPassword("");
      setRepeat("");
      await client.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const needsCurrent = me.data?.user.hasPassword !== false;
  const changePassword = () => {
    if (passwordBusy.current) return;
    const problem = passwordProblem(password);
    const mismatch = !problem && repeat !== password ? "The two passwords don't match." : null;
    setPasswordError(problem);
    setRepeatError(mismatch);
    if (problem || mismatch || (needsCurrent && !current)) return;
    passwordBusy.current = true;
    save.mutate({ password, current: current || undefined }, { onSettled: () => { passwordBusy.current = false; } });
  };
  const identities = useQuery({ queryKey: ["auth-identities"], queryFn: api.identities, enabled: me.data?.via === "session" });
  const unlink = useMutation({
    mutationFn: (provider: string) => api.unlinkIdentity(provider, securityPassword || undefined),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["auth-identities"] }); setUnlinking(null);setSecurityPassword("");toast("Login method removed.", { tone: "ok" }); },
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
  if (!me.data) return null;
  const local = me.data.via === "bypass" || me.data.via === "desktop";
  return (
    <SectionCard
      title="Account"
      description={local ? "You’re using Ensemble on this computer." : `Signed in as ${me.data.user.email}.`}
      actions={
        local ? (
          <a className="btn-primary" href="/signup">
            Create account
          </a>
        ) : (
          <SignOutButton />
        )
      }
    >
      {devTools ? <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line px-3 py-2.5">
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
      </div> : null}
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
        <div className="space-y-5">
          <div className="rounded-xl border border-line p-3">
            <h3 className="text-[13px] font-medium">Profile</h3>
            <p className="mt-1 text-[12px] text-muted">These details personalize setup. Only your name is required.</p>
            <div className="mt-3">
              <ProfileForm
                initial={{ name: me.data.user.name, profile: me.data.user.profile }}
                submitLabel="Save profile"
                pending={profileSave.isPending}
                requireChange
                onDirtyChange={profileDirty}
                onSubmit={(values) => {
                  if (profileBusy.current) return;
                  profileBusy.current = true;
                  profileSave.mutate(values, { onSettled: () => { profileBusy.current = false; } });
                }}
              />
            </div>
          </div>
          <button type="button" className="btn" data-jump-label="Change password" disabled={save.isPending} onClick={() => setPasswordOpen(true)}>{needsCurrent ? "Change password" : "Add a password"}</button>
          <Modal open={passwordOpen} onClose={() => { setPasswordOpen(false); setCurrent(""); setPassword(""); setRepeat(""); setPasswordError(null); setRepeatError(null); }} title={needsCurrent ? "Change password" : "Add a password"} width={480}>
          <form
            className="space-y-3"
            data-password-form
            onSubmit={(event) => {
              event.preventDefault();
              changePassword();
            }}
          >
            <p className="mt-1 text-[12px] text-muted">{PASSWORD_RULE} Other devices are signed out when it changes.</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {needsCurrent ? (
                <PasswordField className="sm:col-span-2" label="Current password" autoComplete="current-password" maxLength={256} value={current} onChange={setCurrent} />
              ) : null}
              <PasswordField
                label="New password"
                autoComplete="new-password"
                maxLength={256}
                value={password}
                onChange={(value) => {
                  setPassword(value);
                  setPasswordError(null);
                  if (repeatError && value === repeat) setRepeatError(null);
                }}
                onBlur={() => setPasswordError(password ? passwordProblem(password) : null)}
                error={passwordError}
              />
              <PasswordField
                label="Confirm new password"
                autoComplete="new-password"
                maxLength={256}
                value={repeat}
                onChange={(value) => {
                  setRepeat(value);
                  setRepeatError(null);
                }}
                onBlur={() => setRepeatError(repeat && repeat !== password ? "The two passwords don't match." : null)}
                error={repeatError}
              />
            </div>
            {save.error ? <p role="alert" className="mt-2 text-[13px] text-danger">{save.error.message}</p> : null}
            <button type="submit" className="btn-primary mt-3" disabled={save.isPending || !password || !repeat || (needsCurrent && !current)}>
              {save.isPending ? "Saving..." : "Save password"}
            </button>
          </form>
          </Modal>
        </div>
      )}
      {!local ? (
        <div className="mt-5 space-y-4">
          <div>
            <h3 className="flex items-center gap-1.5 text-[13px] font-medium">Linked login methods <InfoTip text="Sign-in methods do not connect mail or repositories. Changes may require a recent sign-in." /></h3>
            {identities.error ? <p role="alert" className="mt-2 text-[13px] text-muted">{identities.error.message}</p> : null}
            <div className="mt-2 flex flex-wrap gap-2">
              {identities.data?.providers.map((provider) => {
                const linked = identities.data.identities.some((identity) => identity.provider === provider);
                const label = provider === "github" ? "GitHub" : provider === "google" ? "Google" : "Microsoft";
                return linked ? (
                  <button key={provider} type="button" className="btn" disabled={unlink.isPending || (!me.data.user.hasPassword && identities.data.identities.length <= 1)} onClick={() => {setSecurityPassword("");setUnlinking(provider);}}><BrandLogo id={provider} size={18} />Unlink {label}</button>
                ) : <a key={provider} href={`${HUB_API}/api/auth/oauth/${provider}/start?link=1`} className="btn"><BrandLogo id={provider} size={18} />Link {label}</a>;
              })}
            </div>
          </div>
          <div className="border-t border-line pt-4">
            <button type="button" className="btn" disabled={exported.isPending} onClick={() => exported.mutate()}>{exported.isPending ? "Exporting..." : "Export account data (JSON)"}</button>
            <p className="mt-2 text-[12px] text-muted">Exports your data, not API tokens, connector secrets, or model keys.</p>
          </div>
        </div>
      ) : null}
      <Modal open={Boolean(unlinking)} onClose={()=>{setUnlinking(null);setSecurityPassword("");}} title="Remove this sign-in method?" width={440}><p className="mb-3 text-[13px] text-muted">Your work stays in Ensemble. You can sign in with your other methods.</p>{me.data.user.hasPassword ? <PasswordField label="Password to remove this method" autoComplete="current-password" value={securityPassword} onChange={setSecurityPassword}/> : <p className="text-[13px] text-muted">For an older session, sign in again before removing a login method.</p>}<div className="mt-4 flex justify-end gap-2"><button className="btn" onClick={()=>setUnlinking(null)}>Cancel</button><button className="btn btn-danger" disabled={unlink.isPending||(me.data.user.hasPassword&&!securityPassword)} onClick={()=>unlinking&&unlink.mutate(unlinking)}>Remove method</button></div></Modal>
    </SectionCard>
  );
}

export function DeleteAccountSection() {
  const client = useQueryClient();
  const toast = useToast();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [password, setPassword] = useState("");
  const deletion = useMutation({
    mutationFn: () => api.deleteAccount(password || undefined),
    onSuccess: () => { clearBrowserTabSession(); client.clear(); window.location.href = "/signup"; },
    onError: (error) => toast(error.message, { tone: "error" }),
  });
  if (!me.data || me.data.via === "bypass" || me.data.via === "desktop") return null;
  const close = () => { if (!deletion.isPending) { setOpen(false); setConfirmation(""); setPassword(""); } };
  return (
    <SectionCard title="Delete account" description="Permanently delete your hosted account." actions={<button type="button" className="btn text-danger" onClick={() => setOpen(true)}>Delete account…</button>}>
      <Modal open={open} onClose={close} title="Delete your account?" width={440}>
        <p className="text-[13px] leading-5 text-muted">This cannot be undone. Hosted data is removed and paired devices are revoked; files on your computer stay. Stop active runs first.</p>
        <label className="mt-4 block text-[13px]">Type DELETE to confirm
          <input aria-label="Type DELETE to confirm" className="field mt-1 w-full" value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" />
        </label>
        {me.data.user.hasPassword ? <PasswordField className="mt-3" label="Password to delete account" autoComplete="current-password" value={password} onChange={setPassword} /> : <p className="mt-3 text-[12px] text-muted">Sign in again if your session is older than 10 minutes.</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn" disabled={deletion.isPending} onClick={close}>Cancel</button>
          <button type="button" className="btn text-danger" disabled={confirmation !== "DELETE" || (me.data.user.hasPassword && !password) || deletion.isPending} onClick={() => deletion.mutate()}>
            {deletion.isPending ? "Deleting…" : "Permanently delete account"}
          </button>
        </div>
      </Modal>
    </SectionCard>
  );
}
