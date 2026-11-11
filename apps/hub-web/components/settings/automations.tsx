"use client";

import type { ReactNode } from "react";
import { SKILL_LEARNING_MIN_ITEMS, SKILL_LEARNING_WAIT_DAYS, type AutomationTier, type Settings } from "@ensemble/shared-types";
import { tierModelName } from "@/lib/included";
import { SectionCard, SettingRow, Toggle } from "../ui";
import { NumberField } from "./number-field";
import { TIERS } from "./models";

type Plain = Record<string, unknown>;

function TierPicker({ label, value, settings, disabled, onChange }: { label: string; value: AutomationTier; settings: Settings; disabled?: boolean; onChange: (tier: AutomationTier) => void }) {
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as AutomationTier)} className="field w-56 truncate">
      {TIERS.map((tier) => (
        <option key={tier.id} value={tier.id}>
          {tier.label.replace(" model", "")} · {tierModelName(settings.models[tier.id].provider, settings.models[tier.id].model)}
        </option>
      ))}
    </select>
  );
}

/** A model tier, then the switch: every automation lines up its pickers and its switches in two columns. */
function Controls({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-end gap-3">{children}</div>;
}

/** Work Ensemble does on its own: a switch each and, when it calls a model, the tier it uses. */
export function AutomationsSection({ settings, patch }: { settings: Settings; patch: (value: Plain) => void }) {
  const auto = settings.automations;
  const set = (value: Plain) => patch({ automations: value });
  return (
    <SectionCard
      title="Automations"
      description="What Ensemble does without being asked, and the model tier each uses."
      info="A switch only stops the automatic run. Suggest tasks on a meeting, Prepare on a calendar event and the assistant still work when you ask. Notices about agent work are in Settings › Notifications › Nudges."
    >
      <div className="divide-y divide-[var(--line)]">
        <SettingRow
          title="Meeting automations"
          description="Proposed tasks after each meeting, and a brief before recurring ones."
          info="When a transcript or notes arrive: a summary, decisions and proposed tasks that quote who asked for what; you accept or dismiss each. Before a meeting whose series has notes: a short brief of last time, your open work from it and what others owe. Meetings of a series share a project."
        >
          <Controls>
            <TierPicker label="Model for meeting automations" value={auto.meetings.tier} settings={settings} disabled={!auto.meetings.enabled} onChange={(tier) => set({ meetings: { tier } })} />
            <Toggle label="Meeting automations" checked={auto.meetings.enabled} onChange={(enabled) => set({ meetings: { enabled } })} />
          </Controls>
        </SettingRow>
        {auto.meetings.enabled ? (
          <SettingRow title="Brief before a meeting">
            <Controls>
              <NumberField label="Minutes before a meeting to prepare" min={5} max={240} unit="min before" width="w-56" value={auto.meetings.minutesBefore} onChange={(minutesBefore) => set({ meetings: { minutesBefore } })} />
              <span className="w-11 shrink-0" aria-hidden />
            </Controls>
          </SettingRow>
        ) : null}
        <SettingRow title="Summarize uploaded files" description="Used in search and by agents.">
          <Controls>
            <TierPicker label="Model for file summaries" value={auto.fileSummaries.tier} settings={settings} disabled={!auto.fileSummaries.enabled} onChange={(tier) => set({ fileSummaries: { tier } })} />
            <Toggle label="Summarize uploaded files" checked={auto.fileSummaries.enabled} onChange={(enabled) => set({ fileSummaries: { enabled } })} />
          </Controls>
        </SettingRow>
        <SettingRow
          title="Learn skills from finished work"
          description="How you write PRs, emails and reports."
          info={`Once at least ${SKILL_LEARNING_MIN_ITEMS} completed tasks and deliverables are past the completed window (Data retention), Ensemble reads them to add or update your skills, then moves them to Trash. Off: they move to Trash unread. If the model cannot answer (an AI plan on a computer that is offline), learning waits; after ${SKILL_LEARNING_WAIT_DAYS} days it uses your lower tiers, then a model included with your account, and says which.`}
        >
          <Controls>
            <TierPicker label="Model for learning skills" value={auto.skillLearning.tier} settings={settings} disabled={!auto.skillLearning.enabled} onChange={(tier) => set({ skillLearning: { tier } })} />
            <Toggle label="Learn personal skills from completed work" checked={auto.skillLearning.enabled} onChange={(enabled) => set({ skillLearning: { enabled } })} />
          </Controls>
        </SettingRow>
      </div>
    </SectionCard>
  );
}
