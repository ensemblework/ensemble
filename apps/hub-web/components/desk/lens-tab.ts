"use client";

import { useEffect, useState } from "react";
import { tabKey } from "./context-tabs";

/** The address of a Context tab. Overview is plain /context. */
export function contextTabHref(key: string): string {
  return key === "overview" ? "/context" : `/context?tab=${encodeURIComponent(key)}`;
}

/**
 * The lens's open tab, kept in step with ?tab=. Choosing a tab pushes its own address
 * straight away, so Back returns to the previous tab. `fromUrl` is ?tab= as the router
 * reads it; Back and in-lens links change it without remounting the lens.
 *
 * A history entry, not a router navigation: the router would wait for the server
 * page before the address changed.
 */
export function useLensTab(tabs: readonly string[], fromUrl: string | null): [string, (label: string) => void] {
  const [tab, setTab] = useState(() => tabs.find((label) => tabKey(label) === fromUrl) ?? "Overview");
  const wanted = tabs.find((label) => tabKey(label) === (fromUrl ?? "overview"));
  useEffect(() => {
    if (wanted) setTab(wanted);
  }, [wanted]);
  const choose = (label: string) => {
    setTab(label);
    const href = contextTabHref(tabKey(label));
    if (`${window.location.pathname}${window.location.search}` !== href) window.history.pushState(null, "", href);
  };
  return [tabs.includes(tab) ? tab : tabs[0]!, choose];
}
