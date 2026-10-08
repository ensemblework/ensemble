"use client";

import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState } from "react";
import { HUB_API, api } from "@/lib/api";
import { isSilentCancellation } from "@/lib/fetch-cancel";
import { eventSourceInit, eventsStreamUrl } from "@/lib/events";
import { invalidateSoon } from "@/lib/invalidate";
import { notify, notifyDecision } from "@/lib/notify";
import { presenceStore } from "@/lib/presence";
import { consumeFlash, flash } from "@/lib/flash";

type LiveState = {
  connected: boolean;
  /** True after a live connection drops, until the next successful open. */
  dropped: boolean;
  working: string | null;
  setWorking: (label: string | null) => void;
};

const LiveContext = createContext<LiveState>({ connected: false, dropped: false, working: null, setWorking: () => {} });

export const useLive = () => useContext(LiveContext);

/** Which cached queries each server event makes stale. */
const INVALIDATES: Record<string, string[][]> = {
  task: [["tasks"], ["task"], ["workspace"], ["graph"], ["entities"], ["task-jobs"], ["shell"]],
  page: [["page"]],
  workspace: [["workspace"], ["agent-state"], ["task-jobs"], ["job"], ["reviews"]],
  device: [["devices"], ["workspace"]],
  agent: [["agent-state"], ["workspace"]],
  deliverable: [["deliverables"], ["graph"]],
  approval: [["approvals"], ["shell"]],
  decision: [["decisions"], ["shell"]],
  "sharing.changed": [["spaces"], ["sharing"], ["shared-with-me"], ["space-members"], ["item-shares"], ["notifications"]],
  notification: [["notifications"]],
  diagram: [["diagrams"]],
  context: [["people"], ["projects"], ["repos"], ["graph"], ["entities"]],
  sync: [["connections"], ["calendar"], ["artifacts"], ["shell"]],
  "assistant.acted": [["tasks"], ["projects"], ["deliverables"], ["reminders"], ["skills"], ["graph"], ["shell"]],
  documents: [["documents"]],
  "reminder.due": [["reminders"], ["shell"]],
  "undo.changed": [["shell"], ["tasks"], ["assistant-messages"], ["ensemble-replies"]],
};

/**
 * Browsers allow six HTTP/1.1 connections per host, and every tab's stream
 * holds one for as long as it is open. Local dev therefore uses the other
 * loopback name. A public NEXT_PUBLIC_HUB_API is used as-is: Vercel closes
 * a rewritten stream at about 120 seconds, so the EventSource must not go
 * through the Next rewrite. withCredentials sends the shared session cookie.
 */
const EVENTS_URL = eventsStreamUrl(HUB_API);

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const client = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [dropped, setDropped] = useState(false);
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: number | undefined;
    let opened = false;
    let sawError = false;

    const close = () => {
      window.clearTimeout(retry);
      source?.close();
      source = null;
      setConnected(false);
    };

    let connecting = false;
    const connect = async () => {
      if (source || connecting || document.visibilityState === "hidden") return;
      connecting = true;
      let ticket: string;
      try {
        ticket = (await api.eventsTicket()).ticket;
      } catch (error) {
        connecting = false;
        if (isSilentCancellation(error)) {
          retry = window.setTimeout(() => void connect(), 500);
          return;
        }
        sawError = true;
        setDropped(true);
        retry = window.setTimeout(() => void connect(), 8000);
        return;
      }
      connecting = false;
      if (source) return;
      source = new EventSource(`${EVENTS_URL}?ticket=${encodeURIComponent(ticket)}`, eventSourceInit());
      source.onopen = () => {
        setConnected(true);
        setDropped(false);
        if (opened || sawError) void client.invalidateQueries();
        opened = true;
        sawError = false;
      };
      source.onerror = () => {
        sawError = true;
        setDropped(true);
        void client.invalidateQueries({ queryKey: ["shell"] });
        close();
        retry = window.setTimeout(() => void connect(), 4000);
      };
      source.addEventListener("decision", (event) => {
        invalidateSoon(client, ["decisions"]);
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as { status?: string; title?: string; source?: string; runnerAccountId?: string | null };
          // In a shared space only the person who can answer is alerted.
          const shell = client.getQueryData<Awaited<ReturnType<typeof api.shell>>>(["shell"]);
          const mine = data.runnerAccountId ? data.runnerAccountId === shell?.user.id : !shell?.space?.shared;
          if (data.status === "pending" && mine) notifyDecision(data.title ?? "An agent is waiting", data.source ?? "agent");
        } catch {
          // ignore malformed frames
        }
      });
      for (const [event, keys] of Object.entries(INVALIDATES)) {
        source.addEventListener(event, () => {
          for (const queryKey of keys) invalidateSoon(client, queryKey);
        });
      }
      // Pages and tasks listen for saves made elsewhere (another tab, or someone in a shared space).
      source.addEventListener("page", (event) => {
        try {
          window.dispatchEvent(new CustomEvent("ensemble:page", { detail: JSON.parse((event as MessageEvent<string>).data) }));
        } catch {
          // ignore malformed frames
        }
      });
      source.addEventListener("diagram", (event) => {
        try {
          window.dispatchEvent(new CustomEvent("ensemble:diagram", { detail: JSON.parse((event as MessageEvent<string>).data) }));
        } catch {
          // ignore malformed frames
        }
      });
      source.addEventListener("presence", (event) => {
        try {
          presenceStore.apply(JSON.parse((event as MessageEvent<string>).data));
        } catch {
          // ignore malformed frames
        }
      });
      source.addEventListener("sharing.changed", () => {
        // Removed from the space you are in: the next request falls back to your own space.
        const before = client.getQueryData<Awaited<ReturnType<typeof api.shell>>>(["shell"])?.space;
        if (!before?.shared) return void client.invalidateQueries({ queryKey: ["shell"] });
        void api
          .shell()
          .then((after) => {
            if (after.space?.id !== before.id) {
              flash(`You no longer have access to ${before.name}. You're back in your own space.`);
              window.location.assign("/");
            } else client.setQueryData(["shell"], after);
          })
          .catch(() => undefined);
      });
      source.addEventListener("reminder.due", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as { title?: string; id?: string };
          notify("Reminder", data.title ?? "A reminder is due.", { tag: data.id, href: "/today" });
        } catch {
          // ignore malformed frames
        }
      });
      source.addEventListener("undo.changed", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as { entryId?: string; direction?: string; label?: string };
          window.dispatchEvent(new CustomEvent("ensemble:undo", { detail: data }));
        } catch {
          window.dispatchEvent(new CustomEvent("ensemble:undo"));
        }
      });
      source.addEventListener("assistant.frame", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as { frame?: { type: string; text?: string } };
          if (data.frame?.type === "status" && data.frame.text) setWorking(data.frame.text);
        } catch {
          // ignore malformed frames
        }
      });
    };

    // Background tabs give their connection back; coming back refreshes what was missed.
    const onVisibility = () => {
      if (document.visibilityState === "hidden") close();
      else {
        void connect();
        void client.invalidateQueries();
      }
    };
    const reconnect = () => void connect();
    const onOnline = () => {
      close();
      void client.invalidateQueries();
      void connect();
    };

    consumeFlash();
    void connect();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", close);
    window.addEventListener("pageshow", reconnect);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", close);
      window.removeEventListener("pageshow", reconnect);
      window.removeEventListener("online", onOnline);
      close();
    };
  }, [client]);

  return <LiveContext.Provider value={{ connected, dropped, working, setWorking }}>{children}</LiveContext.Provider>;
}
