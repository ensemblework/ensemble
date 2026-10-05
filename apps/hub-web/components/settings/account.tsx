"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { useState } from "react";
import { DESK_IDS, DESKS, MARKET_ID } from "@/components/desk/desks";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { clearBrowserTabSession } from "@/lib/tab-session";
import { SectionCard } from "../ui";

export function AccountSection() {
  const toast = useToast();
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
  const save = useMutation({
    mutationFn: (data: { name?: string; password?: string; current?: string }) => api.updateMe(data),
    onSuccess: () => {
      toast("Saved.", { tone: "ok" });
      setCurrent("");
      setPassword("");
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
  if (!me.data) return null;
  const local = me.data.via === "bypass";
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
            Change password
            <div className="mt-1.5 flex gap-2">
              <input type="password" value={current} onChange={(event) => setCurrent(event.target.value)} placeholder="Current" className="field w-full" />
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="New (8+)" className="field w-full" />
              <button type="button" className="btn" disabled={password.length < 8 || !current} onClick={() => save.mutate({ password, current })}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
