"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  CUSTOMIZABLE_SHORTCUTS,
  chordFromEvent,
  customChordProblem,
  formatBinding,
  formatChord,
  type ShortcutBinding,
  type ShortcutOverrides,
} from "@ensemble/shared-types";
import { api } from "@/lib/api";
import { isApplePlatform } from "@/lib/platform";
import { SHORTCUTS_PREFERENCE, useShortcuts } from "@/lib/shortcut-store";
import { useToast } from "../toast";
import { SectionCard, cx } from "../ui";

const GROUP_ORDER = ["Everywhere", "Create", "Go to", "Today", "Code", "Diagrams"];

function Recorder({ binding, bindings, onSave, onCancel }: { binding: ShortcutBinding; bindings: readonly ShortcutBinding[]; onSave: (chord: NonNullable<ShortcutBinding["mac"]>) => void; onCancel: () => void }) {
  const apple = isApplePlatform();
  const [problem, setProblem] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        onCancel();
        return;
      }
      const chord = chordFromEvent(event, apple);
      if (!chord) return;
      setPreview(formatChord(chord, apple));
      const reason = customChordProblem(binding.id, chord, bindings, apple);
      setProblem(reason);
      if (!reason) onSave(chord);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [apple, binding.id, bindings, onCancel, onSave]);
  return (
    <div className="flex flex-col items-end gap-1">
      <span className="shortcut-recording" aria-live="polite">{preview || "Press the new keys…"}</span>
      {problem ? <span role="alert" className="max-w-[260px] text-right text-[12px] text-danger">{problem}</span> : <span className="text-[11.5px] text-faint">Esc to cancel</span>}
    </div>
  );
}

/** Every binding, grouped. Global actions can be given a new chord; the browser's own chords are refused. */
export function ShortcutsTab() {
  const client = useQueryClient();
  const toast = useToast();
  const apple = isApplePlatform();
  const { bindings, overrides } = useShortcuts();
  const [recording, setRecording] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (next: ShortcutOverrides) => api.putPreference(SHORTCUTS_PREFERENCE, next),
    onSuccess: () => client.invalidateQueries({ queryKey: ["preferences"] }),
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
  const update = (id: string, chord: NonNullable<ShortcutBinding["mac"]> | null) => {
    const next = { ...overrides };
    if (chord) next[id] = chord;
    else delete next[id];
    setRecording(null);
    save.mutate(next);
  };
  const groups = GROUP_ORDER.map((group) => ({ group, rows: bindings.filter((binding) => binding.group === group && binding.id !== "capture-key" && binding.id !== "diagram-backspace") })).filter((row) => row.rows.length);
  const changed = Object.keys(overrides).length;
  return (
    <>
      <SectionCard
        title="Keyboard shortcuts"
        description={
          apple
            ? "Change any shortcut marked Change. Use Command or Option with a key. Shortcuts your browser or macOS already uses are refused, so nothing like Command-P stops printing."
            : "Change any shortcut marked Change. Use Ctrl or Alt with a key. Shortcuts your browser or system already uses are refused, so nothing like Ctrl+P stops printing."
        }
        actions={
          changed ? (
            <button type="button" className="btn" disabled={save.isPending} onClick={() => save.mutate({})}>
              Reset all
            </button>
          ) : null
        }
      >
        <p className="text-[12.5px] text-muted">Two-key shortcuts such as <span className="kbd">G</span> then <span className="kbd">T</span> work anywhere you are not typing. A chord you add works alongside them.</p>
      </SectionCard>
      {groups.map(({ group, rows }) => (
        <SectionCard key={group} title={group}>
          <ul className="divide-y divide-line" data-shortcut-group={group}>
            {rows.map((binding) => {
              const customizable = CUSTOMIZABLE_SHORTCUTS.has(binding.id);
              const custom = Boolean(overrides[binding.id]);
              const label = formatBinding(binding, apple);
              return (
                <li key={binding.id} className="flex min-h-11 items-center justify-between gap-4 py-2" data-shortcut={binding.id}>
                  <span className="text-[13.5px]">
                    {binding.label}
                    {custom ? <span className="ml-2 text-[11.5px] text-faint">Changed</span> : null}
                  </span>
                  {recording === binding.id ? (
                    <Recorder binding={binding} bindings={bindings} onSave={(chord) => update(binding.id, chord)} onCancel={() => setRecording(null)} />
                  ) : (
                    <span className="flex items-center gap-2">
                      {label ? <span className={cx("kbd text-[11.5px]", custom && "border-line-strong text-ink")}>{label}</span> : <span className="text-[12px] text-faint">None</span>}
                      {customizable ? (
                        <button type="button" className="btn-ghost px-2 text-[12.5px]" aria-label={`Change shortcut for ${binding.label}`} onClick={() => setRecording(binding.id)}>
                          Change
                        </button>
                      ) : null}
                      {custom ? (
                        <button type="button" className="btn-ghost px-2 text-[12.5px]" aria-label={`Reset shortcut for ${binding.label}`} onClick={() => update(binding.id, null)}>
                          Reset
                        </button>
                      ) : null}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </SectionCard>
      ))}
    </>
  );
}
