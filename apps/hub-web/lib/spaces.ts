"use client";

import { api } from "./api";
import { clearBrowserTabSession } from "./tab-session";

const CHANNEL = "ensemble-space";
/** Another channel object in the same tab also hears a message, so each tab tags its own. */
const TAB = Math.random().toString(36).slice(2);

/**
 * Opens another Ensemble space. Nothing from the old space may stay on screen, so the
 * page reloads into Today after the cookie changes. Other open tabs follow (see
 * `followSpaceSwitches`), because the cookie is shared by every tab.
 */
export async function switchSpace(id: string, to = "/today"): Promise<void> {
  await api.switchSpace(id);
  announceSpace(id);
  enterSpace(to);
}

/** After the server has already opened a space (create, delete). */
export function enterSpace(to = "/today"): void {
  clearBrowserTabSession();
  window.location.assign(to);
}

export function announceSpace(id: string): void {
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ id, tab: TAB });
    channel.close();
  } catch {
    // BroadcastChannel is missing in some embedded browsers; those tabs refresh on their next request.
  }
}

/** Another tab switched space: this one reloads so it does not show one space while writing to another. */
export function followSpaceSwitches(current: () => string | undefined): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent<{ id?: string; tab?: string }>) => {
    if (event.data?.tab === TAB) return;
    if (event.data?.id && event.data.id !== current()) {
      clearBrowserTabSession();
      window.location.reload();
    }
  };
  return () => channel.close();
}

/** The first letter of a space's name, for spaces without an emoji. */
export function spaceInitial(name: string): string {
  const letter = Array.from(name.trim())[0] ?? "S";
  return letter.toUpperCase();
}

/** Emoji offered for a space icon. Kept short on purpose: an icon is a cue, not a picker. */
export const SPACE_ICONS = ["🏠", "💼", "🎓", "📚", "🧪", "🚀", "🎨", "🧭", "🌱", "⚖️", "🛠️", "🎯", "📈", "✍️", "🏃", "🍳", "✈️", "🎵", "💡", "🧘"];
