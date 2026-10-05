"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { SectionCard, SettingRow, Toggle } from "@/components/ui";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { desktopShell } from "@/lib/desktop-param";

/** Pairing and the remote-task switches. They exist only in the desktop app. */
export function RemoteMacSection() {
  const [onMac, setOnMac] = useState(false);
  useEffect(() => setOnMac(desktopShell()), []);
  if (!onMac) return null;
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
    if (window.location.hash === "#this-mac") document.getElementById("this-mac")?.scrollIntoView({ block: "start" });
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
    mutationFn: (body: { enabled?: boolean; runBranchPush?: boolean }) => api.saveRemote(body),
    onSuccess: (_result, body) => {
      if (body.enabled === true) toast("Remote tasks are on.", { tone: "ok" });
      if (body.enabled === false) toast("Remote tasks are off.");
      refresh();
    },
    onError: fail,
  });
  const unpair = useMutation({
    mutationFn: api.unpairRemote,
    onSuccess: () => {
      toast("Unpaired.");
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
      title="This Mac"
      description="Pair with Ensemble on the web, then choose whether tasks assigned there may run on this Mac. The switch stays off until you turn it on here."
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
      <SettingRow title="Allow remote tasks" description="Tasks assigned on the web run on this Mac, with this Mac's model key and the same sandbox. Off until you turn it on.">
        <Toggle checked={Boolean(mac?.enabled)} disabled={!mac?.paired || save.isPending} label="Allow remote tasks" onChange={(enabled) => save.mutate({ enabled })} />
      </SettingRow>
      <SettingRow
        title="Push to the run branch"
        description="Remote tasks may push to their own run branch (ensemble/<run-id>/…) in repos you trust. Anything else still needs a confirmation on this Mac."
      >
        <Toggle
          checked={Boolean(mac?.runBranchPush)}
          disabled={!mac?.paired || save.isPending}
          label="Remote tasks may push to their own run branch"
          onChange={(runBranchPush) => save.mutate({ runBranchPush })}
        />
      </SettingRow>
      {mac?.paired ? (
        <button type="button" className="btn-ghost mt-1 text-[12.5px]" data-testid="remote-unpair" disabled={unpair.isPending} onClick={() => unpair.mutate()}>
          Unpair
        </button>
      ) : null}
    </SectionCard>
  );
}
