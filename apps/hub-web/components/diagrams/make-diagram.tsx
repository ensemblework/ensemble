"use client";

import { useModuleOn } from "@/lib/use-module";

/** Opens the assistant with a prompt. It does not send the message. */
export function prefillAssistant(text: string) {
  window.dispatchEvent(new CustomEvent("ensemble:assistant-prefill", { detail: { text } }));
}

/**
 * Hidden when the template leaves out diagrams. `needsCode` marks an entry point
 * that only works by reading a repo (Context → Repos). Elsewhere, without Code,
 * the prompt drops the repo read and the diagram is drawn from the linked work.
 */
export function MakeDiagramButton({ text, label = "Make a diagram", needsCode = false }: { text: string; label?: string; needsCode?: boolean }) {
  const diagramsOn = useModuleOn("diagrams");
  const codeOn = useModuleOn("code");
  if (!diagramsOn || (needsCode && !codeOn)) return null;
  const prompt = codeOn ? text : withoutRepoReads(text);
  return (
    <button type="button" className="btn-ghost" onClick={() => prefillAssistant(prompt)}>
      {label}
    </button>
  );
}

/** The same prompt without the repo read, for a template that leaves out Code. */
export function withoutRepoReads(text: string): string {
  return text.replace(", then hub_repo_overview for each linked repo", "").replace("Call hub_repo_overview with this repo id, then", "Call");
}

export function taskDiagramPrompt(id: string, title: string): string {
  return `Make a diagram of this task (${id}): “${title}”. Call hub_diagram_context with this task id, then hub_repo_overview for each linked repo, then hub_create_diagram. Draw only what those tools name.`;
}

export function projectDiagramPrompt(id: string, name: string): string {
  return `Make a diagram of this project (${id}): “${name}”. Call hub_diagram_context with this project id, then hub_repo_overview for each linked repo, then hub_create_diagram. Draw only what those tools name.`;
}

export function deliverableDiagramPrompt(id: string, title: string): string {
  return `Make a diagram of this deliverable (${id}): “${title}”. Call hub_diagram_context with this deliverable id, then hub_create_diagram. Draw only what that tool names.`;
}

export function repoDiagramPrompt(id: string, fullName: string): string {
  return `Make a diagram of this repository (${id}): ${fullName}. Call hub_repo_overview with this repo id, then hub_create_diagram. A link is enough. Draw only what the overview names.`;
}

export function refineDiagramPrompt(id: string, title: string, note: string): string {
  return `Refine diagram ${id} (“${title}”). ${note.trim()}\nRead it with hub_get_diagram before you edit. Use hub_edit_diagram and keep ids and locks.`;
}

export function refreshDiagramPrompt(id: string, title: string): string {
  return `Refresh diagram ${id} (“${title}”). The linked work changed since this drawing. Read it with hub_get_diagram, read the new context with hub_diagram_context or hub_repo_overview, then update it with hub_edit_diagram. Keep ids and locks.`;
}
