"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ActAs, AssistantToolArea, Settings } from "@ensemble/shared-types";
import { ActAs as ActAsSchema, ASSISTANT_WRITE_AREAS } from "@ensemble/shared-types";
import { api } from "@/lib/api";
import { relative } from "@/lib/format";
import { useToast } from "../toast";
import { SectionCard, SettingRow, Toggle } from "../ui";
import { Modal } from "./modal";
import { TIERS } from "./models";
import { navigateSettings, useSettingsLocation } from "./url-state";

type Patch = (patch: Record<string, unknown>) => void;
type Props = { settings: Settings; patch: Patch };

export const ACT_AS_LABELS: Record<ActAs, string> = {
  general: "Match my sign-up role",
  student: "Student",
  engineer: "Software engineer",
  teacher: "Teacher",
  lawyer: "Lawyer",
  researcher: "Researcher",
  manager: "Manager or team lead",
  aspirant: "Preparing for an exam",
  maker: "Product maker",
};

export const WRITE_AREAS: Array<{ id: AssistantToolArea; label: string; short: string }> = [
  { id: "tasks", label: "Tasks and pages", short: "Tasks" },
  { id: "projects", label: "Projects and deliverables", short: "Projects" },
  { id: "context", label: "People, repos and context", short: "Context" },
  { id: "skills", label: "Skills", short: "Skills" },
  { id: "reminders", label: "Reminders", short: "Reminders" },
  { id: "runs", label: "Runs", short: "Runs" },
];

/** "Tasks, Projects, Context · Connected apps ask first" */
export function changesSummary(assistant: Pick<Settings["assistant"], "allowedWriteAreas" | "connectedAppWrites">): string {
  const allowed = WRITE_AREAS.filter((area) => assistant.allowedWriteAreas.includes(area.id)).map((area) => area.short);
  const inside = !allowed.length ? "Nothing inside Ensemble" : allowed.length === WRITE_AREAS.length ? "Everything inside Ensemble" : allowed.join(", ");
  return `${inside} · ${assistant.connectedAppWrites === false ? "Connected apps: off" : "Connected apps ask first"}`;
}

export function AssistantSection({ settings, patch }: Props) {
  const assistant = settings.assistant;
  const location = useSettingsLocation();
  const field = (ActAsSchema.options as readonly string[]).includes(assistant.actAs) ? assistant.actAs : "general";
  return (
    <SectionCard title="The assistant" description="How the chat in the corner talks to you, and what it may change on its own.">
      <div className="divide-y divide-[var(--line)]">
        <SettingRow title="Your field" description="Shapes the assistant's tone and the suggestions it offers. It does not change what Ensemble can read or change.">
          <select aria-label="Your field" value={field} onChange={(event) => patch({ assistant: { actAs: event.target.value } })} className="field max-w-[220px]">
            {ActAsSchema.options.map((value) => (
              <option key={value} value={value}>
                {ACT_AS_LABELS[value]}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow title="When it wants to change something" description="Preview shows what it wants to change and waits for you to press Apply in the chat.">
          <select aria-label="Write policy" value={assistant.writePolicy} onChange={(event) => patch({ assistant: { writePolicy: event.target.value } })} className="field">
            <option value="preview">Show me a preview first</option>
            <option value="immediate">Just do it (undoable)</option>
            <option value="needs-me">Queue it on Needs me</option>
          </select>
        </SettingRow>
        <SettingRow title="Default model preset" description="The tier the chat starts on. Pick another one per message in the chat.">
          <select aria-label="Default complexity" value={assistant.defaultTier} onChange={(event) => patch({ assistant: { defaultTier: event.target.value } })} className="field">
            {TIERS.map((tier) => (
              <option key={tier.id} value={tier.id}>
                {tier.label.replace(" model", "")} · {settings.models[tier.id].model}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow title="What it may change" description={<span data-testid="changes-summary">{changesSummary(assistant)}</span>}>
          <button type="button" className="btn" aria-haspopup="dialog" onClick={() => navigateSettings({ dialog: "changes" })}>
            Change
          </button>
        </SettingRow>
      </div>
      <ChangesDialog open={location.dialog === "changes"} onClose={() => navigateSettings({ dialog: null })} settings={settings} patch={patch} />
    </SectionCard>
  );
}

export function ChangesDialog({ open, onClose, settings, patch }: Props & { open: boolean; onClose: () => void }) {
  const assistant = settings.assistant;
  const allowed = assistant.allowedWriteAreas;
  const toggle = (id: AssistantToolArea) =>
    patch({ assistant: { allowedWriteAreas: allowed.includes(id) ? allowed.filter((value) => value !== id) : [...allowed, id] } });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="What the assistant may change"
      description="Your own data inside Ensemble. Every change can be undone from the app bar."
      width={560}
      testId="changes-dialog"
      footer={
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => patch({ assistant: { allowedWriteAreas: [...ASSISTANT_WRITE_AREAS], connectedAppWrites: true } })}
          >
            Reset to default
          </button>
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      }
    >
      <fieldset>
        <legend className="text-[13px] font-semibold">Inside Ensemble</legend>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {WRITE_AREAS.map((area) => (
            <label key={area.id} className="row-tile flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px]">
              <input type="checkbox" checked={allowed.includes(area.id)} onChange={() => toggle(area.id)} className="accent-[rgb(var(--accent-rgb))]" />
              {area.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-4 border-t border-line pt-2">
        <SettingRow
          title="Connected apps"
          description="Propose changes in Google, Microsoft and other connected apps: calendar invites, documents, issues. Each one waits for your Apply, whatever the setting above says."
        >
          <Toggle label="Connected apps" checked={assistant.connectedAppWrites !== false} onChange={(connectedAppWrites) => patch({ assistant: { connectedAppWrites } })} />
        </SettingRow>
      </div>
      <p className="mt-2 text-[12px] text-muted">
        Anything that leaves the building, sending mail, opening a pull request, posting to chat, keeps its own approval gate whatever this is set to.
      </p>
    </Modal>
  );
}

/** Conditions the assistant watches after "tell me when …". Hidden while there are none. */
export function WatchersSection() {
  const client = useQueryClient();
  const toast = useToast();
  const watchers = useQuery({ queryKey: ["watchers"], queryFn: api.watchers });
  const cancel = useMutation({
    mutationFn: api.cancelWatcher,
    onSuccess: () => {
      toast("Stopped watching.");
      void client.invalidateQueries({ queryKey: ["watchers"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const rows = (watchers.data?.watchers ?? []).filter((row) => row.status === "active");
  if (!rows.length) return null;
  return (
    <div id="watchers" className="scroll-mt-6">
      <SectionCard title="Watching for you" description="When you ask “tell me when …”, the assistant keeps an eye out and lets you know. Cancel one any time.">
        <ul className="divide-y divide-[var(--line)]">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-3 py-2 text-[13px]">
              <span className="min-w-0 flex-1">
                <span className="block truncate">{row.message}</span>
                <span className="block text-[12px] text-faint">since {relative(row.createdAt)}</span>
              </span>
              <button type="button" className="btn h-7 px-2 text-[12px]" disabled={cancel.isPending && cancel.variables === row.id} onClick={() => cancel.mutate(row.id)}>
                Cancel
              </button>
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}
