/**
 * Things handed to the assistant from a right-click (components/context-menu): a part of a page, a
 * block, a table or a reply, always with the page it comes from, or a whole page or task. The dock
 * holds them above its box until the message goes; the message carries each one quoted with where it
 * is from (so the conversation keeps it), and the turn's reference says which record that is, by id,
 * so the assistant can read the rest of it.
 */
import type { PageMention } from "@ensemble/shared-types";

/** `plot`: a Plots canvas (id is the canvas). `file`: a file in Code (id is the repository, title the path). */
export type AttachSource = { kind: "page" | "task" | "meeting" | "project" | "deliverable" | "view" | "reply" | "plot" | "file"; id: string; title: string };
/** `text` empty: the whole page or task. */
export type AssistantAttachment = { text: string; source: AttachSource };
/**
 * `context`: facts sent with the message as its reference (never shown in the chat). `tier`: the tier
 * for this one message. `fresh`: ask in a new chat rather than the open one.
 */
export type AttachRequest = { attachment?: AssistantAttachment; mention?: PageMention; prompt?: string; send?: boolean; context?: string; tier?: "easy" | "medium" | "high" | "max"; fresh?: boolean };

export const ATTACH_EVENT = "ensemble:assistant-attach";
const MAX_TEXT = 6000;

export function attachToAssistant(request: AttachRequest): void {
  window.dispatchEvent(new CustomEvent<AttachRequest>(ATTACH_EVENT, { detail: request }));
}

/** One-click asks about what was picked; each sends at once with it attached. */
export const ASK_PRESETS: Array<{ id: string; label: string; prompt: string }> = [
  { id: "explain", label: "Explain this", prompt: "Explain this." },
  { id: "summarize", label: "Summarize", prompt: "Summarize this in a few bullet points." },
  { id: "improve", label: "Improve the writing", prompt: "Improve the writing of this. Keep my meaning and tone, and show me the new text." },
  { id: "shorter", label: "Make it shorter", prompt: "Make this shorter. Show me the new text." },
  { id: "actions", label: "Find action items", prompt: "List the action items in this, with who and when where they are named." },
  { id: "translate", label: "Translate to English", prompt: "Translate this to English." },
];

const KIND_WORD: Record<AttachSource["kind"], string> = { page: "page", task: "task", meeting: "meeting notes", project: "project", deliverable: "deliverable", view: "screen", reply: "your earlier reply", plot: "plot canvas", file: "file" };

const clean = (title: string) => title.replace(/[“”\n]/g, "").trim() || "Untitled";

/** The message's head: each attachment quoted (`> …`) with `From “Title”`, or `[Attached: “Title”]` for a whole one. */
export function quoteAttachments(list: AssistantAttachment[]): string {
  return list
    .map((item) => {
      const text = item.text.trim().slice(0, MAX_TEXT);
      if (!text) return `[Attached: “${clean(item.source.title)}”]`;
      return `${text.split(/\r?\n/).map((line) => `> ${line}`).join("\n")}\nFrom “${clean(item.source.title)}”`;
    })
    .join("\n\n");
}

/** What the turn's reference says about them: which records they are, by kind and id (never shown to the person). */
export function attachmentContext(list: AssistantAttachment[]): string {
  if (!list.length) return "";
  const lines = list.map((item) => {
    const where =
      item.source.kind === "view" || item.source.kind === "reply"
        ? `the ${KIND_WORD[item.source.kind]} “${clean(item.source.title)}”`
        : item.source.kind === "file"
          ? `the file “${clean(item.source.title)}” (in the Code repository ${item.source.id})`
          : `the ${KIND_WORD[item.source.kind]} “${clean(item.source.title)}” (${item.source.kind} id ${item.source.id})`;
    return item.text.trim() ? `- A part of ${where}, quoted at the top of the message.` : `- All of ${where}: read it before answering.`;
  });
  return ["The person attached these to their message; read the whole record when you need more than the quoted part:", ...lines].join("\n");
}

export type QuotedPart = { text: string; from: string; whole: boolean };

/** A sent message's quoted attachments and the rest of it, for the chat to show them as cards. */
export function splitQuoted(content: string): { parts: QuotedPart[]; rest: string } {
  const parts: QuotedPart[] = [];
  let rest = content;
  for (;;) {
    const whole = /^\[Attached: “([^”\n]*)”\]\n*/.exec(rest);
    if (whole) {
      parts.push({ text: "", from: whole[1]!, whole: true });
      rest = rest.slice(whole[0].length);
      continue;
    }
    // "— from" is how messages sent before the plain "From" were written.
    const quote = /^((?:> [^\n]*(?:\n|$))+)(?:— from|From) “([^”\n]*)”\n*/.exec(rest);
    if (!quote) break;
    parts.push({ text: quote[1]!.split("\n").filter(Boolean).map((line) => line.replace(/^> /, "")).join("\n"), from: quote[2]!, whole: false });
    rest = rest.slice(quote[0].length);
  }
  return { parts, rest };
}
