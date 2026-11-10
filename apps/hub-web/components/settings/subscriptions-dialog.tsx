"use client";

import { Search, Sparkles, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { SUBSCRIPTION_INFO, SUBSCRIPTION_PROVIDERS, type SubscriptionAgent, type SubscriptionProvider } from "@ensemble/shared-types";
import type { SubscriptionComputer } from "@/lib/api";
import { cx, Tag } from "../ui";
import { Modal } from "./modal";
import { statusOf, SubscriptionMark } from "./subscriptions";

const DOT = { green: "bg-ok", orange: "bg-[var(--warn)]", blue: "bg-accent", gray: "bg-line-strong" } as const;

/**
 * Every AI plan Ensemble can use, like Manage API keys: the ones on your computer first, then the
 * rest with how to add them. Settings › Models shows only the ones found.
 */
export function SubscriptionsDialog({
  open,
  onClose,
  computer,
  tile,
  checkButton,
  header,
}: {
  open: boolean;
  onClose: () => void;
  computer: SubscriptionComputer | null;
  tile: (id: SubscriptionProvider) => ReactNode;
  checkButton: ReactNode;
  header: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const agentOf = (id: SubscriptionProvider): SubscriptionAgent | null => computer?.agents.find((row) => row.id === id) ?? null;
  const found = SUBSCRIPTION_PROVIDERS.filter((id) => agentOf(id));
  const rest = SUBSCRIPTION_PROVIDERS.filter((id) => !agentOf(id));
  const [picked, setPicked] = useState<SubscriptionProvider | null>(null);
  const pane = picked ?? found.find((id) => agentOf(id)?.signedIn === true) ?? found[0] ?? SUBSCRIPTION_PROVIDERS[0]!;
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (id: SubscriptionProvider) => !needle || SUBSCRIPTION_INFO[id].label.toLowerCase().includes(needle) || id.includes(needle);
  }, [query]);
  const signedIn = found.filter((id) => agentOf(id)?.signedIn === true).length;

  const group = (title: string, ids: SubscriptionProvider[]) => {
    const shown = ids.filter(matches);
    if (!shown.length) return null;
    return (
      <div className="flex shrink-0 gap-1 sm:flex-col">
        <div className="hidden px-2 pb-0.5 pt-2 text-2xs uppercase tracking-wide text-faint sm:block">{title}</div>
        {shown.map((id) => {
          const status = statusOf(agentOf(id));
          const active = pane === id;
          return (
            <button
              key={id}
              type="button"
              data-subscription-row={id}
              aria-current={active ? "page" : undefined}
              onClick={() => setPicked(id)}
              className={cx("row-tile flex shrink-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px]", active && "bg-hover font-medium")}
            >
              <SubscriptionMark id={id} size={24} />
              <span className="min-w-0 flex-1 truncate">{SUBSCRIPTION_INFO[id].label}</span>
              <span className={cx("size-1.5 shrink-0 rounded-full", DOT[status.tone])} title={status.text} aria-label={status.text} />
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="AI subscriptions"
      width={960}
      height="min(88dvh, 720px)"
      bodyClassName="p-0"
      scroll={false}
      testId="subscriptions-dialog"
      header={
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles size={15} className="text-accent" aria-hidden />
              <span className="text-[15px] font-semibold">AI subscriptions</span>
              <Tag tone={signedIn ? "green" : "gray"}>{signedIn ? `${signedIn} signed in` : "none signed in"}</Tag>
            </div>
            <p className="mt-0.5 text-[12.5px] text-muted">Plans you already pay for. They run on your computer with your own sign-in; Ensemble never sees it.</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {checkButton}
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <X size={15} />
            </button>
          </div>
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col sm:flex-row">
        <nav className="flex shrink-0 flex-col border-b border-line bg-panel sm:w-[248px] sm:border-b-0 sm:border-r" aria-label="Subscriptions">
          <label className="picker-search m-2.5 mb-1.5">
            <Search size={13} className="shrink-0 text-faint" aria-hidden />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a plan" aria-label="Find a plan" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint" />
          </label>
          <div className="flex min-h-0 gap-1 overflow-x-auto px-2 pb-2 sm:flex-1 sm:flex-col sm:overflow-y-auto sm:overflow-x-hidden">
            {group(computer ? `On ${computer.name}` : "On your computer", found)}
            {group(found.length ? "More plans" : "Plans", rest)}
            {!SUBSCRIPTION_PROVIDERS.some(matches) ? <p className="px-2 py-1 text-[12px] text-muted">No plan by that name.</p> : null}
          </div>
        </nav>
        <section className="min-h-0 flex-1 overflow-y-auto p-5" aria-live="polite" data-subscription-pane={pane}>
          {header}
          <div className="mt-3">{tile(pane)}</div>
        </section>
      </div>
    </Modal>
  );
}
