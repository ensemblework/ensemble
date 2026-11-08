"use client";

import { SKILL_LEARNING_MIN_ITEMS, SKILL_LEARNING_WAIT_DAYS, type AutomationTier, type Settings } from "@ensemble/shared-types";
import { tierModelName } from "@/lib/included";
import { SectionCard, SettingRow, Toggle } from "../ui";
import { NumberField } from "./number-field";
import { TIERS } from "./models";

type Plain = Record<string, unknown>;

function TierPicker({ label, value, settings, disabled, onChange }: { label: string; value: AutomationTier; settings: Settings; disabled?: boolean; onChange: (tier: AutomationTier) => void }) {
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as AutomationTier)} className="field">
      {TIERS.map((tier) => (
        <option key={tier.id} value={tier.id}>
          {tier.label.replace(" model", "")} · {tierModelName(settings.models[tier.id].provider, settings.models[tier.id].model)}
        </option>
      ))}
    </select>
  );
}

/** Work Ensemble does on its own: each with its own switch and, when it calls a model, the tier it uses. */
export function AutomationsSection({ settings, patch }: { settings: Settings; patch: (value: Plain) => void }) {
  const auto = settings.automations;
  const set = (value: Plain) => patch({ automations: value });
  return (
    <SectionCard
      title="Automations"
      description="What Ensemble does for you without being asked. Switched off, you can still ask for each one on the record itself."
      info="Each switch here only stops the automatic run. Suggest tasks on a meeting, Prepare on a calendar event and the assistant still work when you ask."
    >
      <SettingRow title="Suggest tasks from meetings" description="When a transcript or notes arrive: a summary, decisions and proposed tasks that quote who asked for what. You accept or dismiss each one.">
        <Toggle label="Suggest tasks from meetings" checked={auto.meetingTasks.enabled} onChange={(enabled) => set({ meetingTasks: { enabled } })} />
      </SettingRow>
      <SettingRow title="Model for meeting tasks" description="The tier that reads meetings. A long transcript reads better on a stronger model.">
        <TierPicker label="Model for meeting tasks" value={auto.meetingTasks.tier} settings={settings} onChange={(tier) => set({ meetingTasks: { tier } })} />
      </SettingRow>
      <SettingRow title="Prepare for recurring meetings" description="Before a meeting whose series has notes in Ensemble: a short brief of last time, your open work from it and what others owe.">
        <Toggle label="Prepare for recurring meetings" checked={auto.meetingPrep.enabled} onChange={(enabled) => set({ meetingPrep: { enabled } })} />
      </SettingRow>
      <SettingRow title="Minutes before a meeting to prepare">
        <NumberField label="Minutes before a meeting to prepare" min={5} max={240} unit="min" value={auto.meetingPrep.minutesBefore} onChange={(minutesBefore) => set({ meetingPrep: { minutesBefore } })} />
      </SettingRow>
      <SettingRow title="Model for meeting prep">
        <TierPicker label="Model for meeting prep" value={auto.meetingPrep.tier} settings={settings} disabled={!auto.meetingPrep.enabled} onChange={(tier) => set({ meetingPrep: { tier } })} />
      </SettingRow>
      <SettingRow title="Summarize uploaded files" description="A short summary of each file you upload, used in search and by agents.">
        <div className="flex items-center gap-3">
          <TierPicker label="Model for file summaries" value={auto.fileSummaries.tier} settings={settings} disabled={!auto.fileSummaries.enabled} onChange={(tier) => set({ fileSummaries: { tier } })} />
          <Toggle label="Summarize uploaded files" checked={auto.fileSummaries.enabled} onChange={(enabled) => set({ fileSummaries: { enabled } })} />
        </div>
      </SettingRow>
      <SettingRow title="Meetings of a series share a project" description="A meeting with no project takes the one an earlier meeting of its series has. No model.">
        <Toggle label="Meetings of a series share a project" checked={auto.linkMeetingSeries} onChange={(linkMeetingSeries) => set({ linkMeetingSeries })} />
      </SettingRow>
      <SettingRow
        title="Learn personal skills from completed work"
        description={`Once at least ${SKILL_LEARNING_MIN_ITEMS} completed tasks and deliverables are past the completed window (Data retention), Ensemble reads them to add or update your skills (how you write PRs, emails, reports…), then moves them to Trash. Off: they move to Trash unread.`}
        info={`If this model cannot answer (an AI plan on a computer that is offline), learning waits and tells you. After ${SKILL_LEARNING_WAIT_DAYS} days it uses your lower tiers, then a model included with your Ensemble account, and says which.`}
      >
        <div className="flex items-center gap-3">
          <TierPicker label="Model for learning skills" value={auto.skillLearning.tier} settings={settings} disabled={!auto.skillLearning.enabled} onChange={(tier) => set({ skillLearning: { tier } })} />
          <Toggle label="Learn personal skills from completed work" checked={auto.skillLearning.enabled} onChange={(enabled) => set({ skillLearning: { enabled } })} />
        </div>
      </SettingRow>
      <SettingRow title="Tell me when agent work waits for review" description="A notification when an agent finishes a task and its work is ready for you. No model.">
        <Toggle label="Tell me when agent work waits for review" checked={auto.reviewNotices} onChange={(reviewNotices) => set({ reviewNotices })} />
      </SettingRow>
    </SectionCard>
  );
}
