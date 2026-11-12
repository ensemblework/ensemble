"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { SectionCard, SettingRow, Toggle } from "@/components/ui";
import { confirmAction } from "@/components/ask-dialog";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { desktopShell } from "@/lib/desktop-param";
import { scrollSettingIntoView } from "./navigation";

/** Pairing and the remote-task switches. They exist only in the desktop app. */
export function RemoteMacSection() {
  const [onMac, setOnMac] = useState(false);
  useEffect(() => setOnMac(desktopShell()), []);
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, enabled: onMac });
  // Local only: this computer is never paired (Account above has the one-time move to an account).
  if (!onMac || !me.data || me.data.localOnly) return null;
  return <RemoteMacSettings />;
}

function RemoteMacSettings() {
  const client = useQueryClient();
  const toast = useToast();
  const query = useQuery({ queryKey: ["remote"], queryFn: api.remote, refetchInterval: 5000 });
  const mac = query.data;
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  useEffect(() => {
    if (mac?.apiBase) setUrl((current) => current || mac.apiBase || "");
  }, [mac?.apiBase]);
  useEffect(() => {
    const card = window.location.hash === "#this-mac" ? document.getElementById("this-mac") : null;
    if (card) scrollSettingIntoView(card.closest<HTMLElement>("[data-settings-main]"), card, "start");
  }, []);
  const fail = (error: unknown) => toast((error as Error).message, { tone: "error" });
  const refresh = () => void client.invalidateQueries({ queryKey: ["remote"] });
  const pair = useMutation({
    mutationFn: () => api.pairRemote({ apiBase: url.trim(), code: code.trim() }),
    onSuccess: () => {
      setCode("");
      toast("Paired. Remote tasks stay off until you turn them on.", { tone: "ok" });
      refresh();
    },
    onError: fail,
  });
  const save = useMutation({
    mutationFn: (body: { enabled?: boolean; acceptWebApprovals?: boolean; browseFiles?: boolean; webEdit?: boolean; webTerminal?: boolean }) => api.saveRemote(body),
    onSuccess: (_result, body) => {
      refresh();
    },
    onError: fail,
  });
  const unpair = useMutation({
    mutationFn: api.unpairRemote,
    onSuccess: () => {
      refresh();
    },
    onError: fail,
  });
  const status = !mac
    ? "Checking…"
    : mac.disconnected?.reason
      ? mac.disconnected.reason
      : !mac.paired
        ? "Not paired"
        : mac.unreachable
          ? mac.unreachable
          : mac.enabled
            ? mac.online
              ? "Online"
              : "Connecting"
            : "Remote tasks are off";
  return (
    <SectionCard
      title={mac?.platform === "macos" ? "This Mac" : "This computer"}
      description="Pair with Ensemble on the web to run its tasks here."
      info="Pair with Ensemble on the web, then choose whether tasks assigned there may run on this computer. The switch stays off until you turn it on here."
    >
      <div className="mb-3 flex items-center gap-2 text-[13px]" data-testid="remote-status">
        <span className={mac?.online ? "h-2 w-2 rounded-full bg-ok" : "h-2 w-2 rounded-full bg-faint"} data-testid="remote-online" data-online={mac?.online ? "yes" : "no"} />
        <span className="min-w-0">{status}</span>
        {mac?.paired && mac.deviceName ? <span className="text-faint">· {mac.deviceName}</span> : null}
      </div>
      <label className="mb-2 block text-[12.5px] text-muted" htmlFor="remote-url">
        Address of Ensemble on the web
      </label>
      <input
        id="remote-url"
        data-testid="remote-url"
        className="field mb-3 w-full"
        placeholder="https://api.example.com"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        autoComplete="off"
      />
      <label className="mb-2 block text-[12.5px] text-muted" htmlFor="remote-code">
        Pairing code
      </label>
      <div className="mb-1 flex gap-2">
        <input
          id="remote-code"
          data-testid="remote-code"
          className="field min-w-0 flex-1 font-mono tracking-widest"
          placeholder="8 characters"
          value={code}
          maxLength={8}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          autoComplete="off"
        />
        <button type="button" className="btn" data-testid="remote-pair" disabled={pair.isPending || code.trim().length !== 8 || !url.trim()} onClick={() => pair.mutate()}>
          Pair
        </button>
      </div>
      {mac && !mac.paired ? <p className="mt-3 text-[12px] text-muted">Pair this computer to turn on the switches below.</p> : null}
      <div className="mt-2 divide-y divide-[var(--line)]">
      <SettingRow title="Allow remote tasks" description="Web tasks run here, in the same sandbox." info="Tasks assigned on the web run on this computer, with this computer's model key and the same sandbox. Off until you turn it on.">
        <Toggle checked={Boolean(mac?.enabled)} disabled={!mac?.paired || save.isPending} label="Allow remote tasks" onChange={(enabled) => save.mutate({ enabled })} />
      </SettingRow>
      <SettingRow
        title="Accept approvals from the web and phone"
        description="Answer this computer's questions from Needs me."
        info="You can approve anything a task on this computer asks (a push, trusting a folder, a path outside it) from Needs me on the web, with a confirm step, and the mode, internet and limits chosen there apply here. Off: those answers only on this computer, and web settings can only narrow."
      >
        <Toggle
          checked={mac?.acceptWebApprovals !== false}
          disabled={!mac?.paired || save.isPending}
          label="Accept approvals from the web and phone"
          onChange={(acceptWebApprovals) => save.mutate({ acceptWebApprovals })}
        />
      </SettingRow>
      <SettingRow
        title="Show task files on the web"
        description="Read changed files on the web. Never keys or secrets."
        info="Ensemble on the web shows the files tasks here changed (their text is sent when a run ends) and opens any file or folder in a task's folder, read from here when you open it. Never git's own files or files of keys and secrets. Off: only file names and line counts."
      >
        <Toggle
          checked={mac?.browseFiles !== false}
          disabled={!mac?.paired || save.isPending}
          label="Show task files on the web"
          onChange={(browseFiles) => save.mutate({ browseFiles })}
        />
      </SettingRow>
      <SettingRow
        title="Change code from the web"
        description="Edit, commit and push here from the web's Code tab."
        info="The web's Code tab may change code here: accept or reject an agent's changes, edit files, stage, commit, push and pull, in the folders Code may use. Off: the web can still read the code (with the switch above) but not change it."
      >
        <Toggle
          checked={mac?.webEdit !== false}
          disabled={!mac?.paired || save.isPending || mac?.browseFiles === false}
          label="Change code from the web"
          onChange={(webEdit) => save.mutate({ webEdit })}
        />
      </SettingRow>
      <SettingRow
        title="Terminal from the web"
        description="Opens from the web's Code tab after a passkey."
        info="The terminal here may open from the web's Code tab, after you unlock it there with your passkey (it locks after 30 minutes idle, 8 hours at most). The same allow-list as the terminal on this computer: no shells, no network tools, no running repository code."
      >
        <Toggle
          checked={mac?.webTerminal !== false}
          disabled={!mac?.paired || save.isPending}
          label="Terminal from the web"
          onChange={(webTerminal) => save.mutate({ webTerminal })}
        />
      </SettingRow>
      </div>
      {mac?.paired ? (
        <button
          type="button"
          className="btn-ghost mt-1 text-[12.5px]"
          data-testid="remote-unpair"
          disabled={unpair.isPending}
          onClick={() => void confirmAction({ title: "Unpair this computer?", body: "Tasks from the web stop running here. Pair it again with a new code to bring them back.", confirm: "Unpair", danger: true }).then((yes) => yes && unpair.mutate())}
        >
          Unpair
        </button>
      ) : null}
    </SectionCard>
  );
}
