/**
 * Every prompt Ensemble sends a model or an agent, built by the same code that sends it, here with
 * sample values, for Settings → Prompts. A prompt is listed only while something sends it.
 *
 * Each prompt has the same layers: instructions that stay the same across a conversation or run
 * (so the provider's prompt cache and the agent's own session reuse them), a small per-message or
 * per-run context with only what that request needs, and everything else on demand through tools
 * (records, playbooks, connected apps).
 */
import type { WorkspaceJob } from "@prisma/client";
import { DEFAULT_SETTINGS, personaBlock } from "@ensemble/shared-types";
import { writeModeNote } from "../assistant/agent.js";
import { appsPrompt } from "../assistant/apps.js";
import type { AppConnection } from "../assistant/connections.js";
import { playbooksFor } from "../assistant/skills/index.js";
import { assistantInstructions, turnContext } from "../assistant/state.js";
import { TRIAGE_PROMPT } from "../connectors/triage.js";
import { SKILL_MINING_PROMPT } from "../jobs/skill-mining.js";
import { howYouRun } from "../subscriptions/turn.js";
import { chatPrompt, ownAgentPrompt, workingNotes } from "../workspace/agent.js";
import type { JobContext } from "../workspace/tools.js";

export type PromptEntry = { id: string; title: string; when: string; purpose: string; body: string };

const SAMPLE_APP: AppConnection = { id: "google", name: "Google Workspace", via: ["sign-in"], account: null, uses: [], tools: [], publicOnly: false, meetings: true, names: ["google"] };

function sampleRun(): JobContext {
  return {
    root: "~/ensemble-workspace/runs/<run>",
    workspace: "~/ensemble-workspace",
    sandboxed: true,
    network: true,
    accessMode: "read-write",
    outsideAccess: "read",
    runBranch: "",
    secretEnv: {},
    job: { unattended: false, accessMode: "read-write", delivery: "push", provider: "claude-code", context: {}, maxToolCalls: 200, maxTurns: 60, maxMinutes: 60 } as unknown as WorkspaceJob,
  } as unknown as JobContext;
}

let cached: PromptEntry[] | null = null;

export function promptCatalog(): PromptEntry[] {
  if (cached) return cached;
  const state = { skills: [{ id: "skill", name: "Release notes", description: "How I like release notes written" }], user: { firstName: "Mira", onboardingRole: "engineer", spaceName: "Mira's space" } };
  const run = sampleRun();
  cached = [
    {
      id: "assistant.instructions",
      title: "Assistant: instructions",
      when: "Every message in the assistant chat. The same text all through a chat.",
      purpose: "How to work in Ensemble: look things up with tools, link records, how changes are applied, dates, sources. Records, playbooks and app details come from tools when needed.",
      body: assistantInstructions(state, {
        timezone: "Europe/London",
        writeMode: writeModeNote(DEFAULT_SETTINGS.assistant.writePolicy),
        persona: personaBlock("engineer", "Mira"),
        apps: appsPrompt({ connected: [SAMPLE_APP], broken: [] }, DEFAULT_SETTINGS),
        playbooks: playbooksFor(),
      }),
    },
    {
      id: "assistant.context",
      title: "Assistant: each message",
      when: "Before the message you type, every time.",
      purpose: "Only what this message is about: today and its week, what you are looking at, the open item, what you selected or mentioned, and a guide for the area when your words point at one.",
      body: `${turnContext(
        { path: "/tasks/<id>", label: "a task", timezone: "Europe/London", today: "2026-10-29", weekday: "Thursday", open: { id: "<id>", title: "Write the release notes", status: "todo", due: "2026-10-30", priority: "p1" } },
        { today: "2026-10-29", weekday: "Thursday", timezone: "Europe/London" },
      )}\n\nDraft these from what we finished this week.`,
    },
    {
      id: "assistant.subscription",
      title: "Assistant on your own AI plan",
      when: "Added to the instructions when the assistant runs on Claude, Codex, Copilot or another agent on your computer. One chat is one session of that agent; a new chat starts a new one.",
      purpose: "Says it has only Ensemble's tools there.",
      body: howYouRun("claude-code"),
    },
    {
      id: "agent.brief",
      title: "Coding agent: a task",
      when: "When Claude Code, Codex, Copilot, Cursor or another coding agent starts a task (Ask mode, No limits for git, internet on).",
      purpose: "The task as you wrote it, then how the run works: only the limits that apply, how to ask, and the summary to end with.",
      body: `# <task title>\n\n<the task's description and page>\n\n---\n${workingNotes(run)}`,
    },
    {
      id: "agent.chat",
      title: "Coding agent: terminal chat",
      when: "The first message in the CLI's Chat tab. Later messages are sent as you typed them; the rules go again only after you change the run's settings.",
      purpose: "Where it works, the board tools it has, and how the run works.",
      body: chatPrompt(run, "<your message>", { resumed: false }),
    },
    {
      id: "agent.ensemble",
      title: "Ensemble's own agent",
      when: "A task given to Ensemble's own agent (a model key or included models) to do in a folder.",
      purpose: "Its tools' rules, the run's limits and budget. The task brief follows as the message.",
      body: ownAgentPrompt("code", run, DEFAULT_SETTINGS, "Mira"),
    },
    {
      id: "agent.research",
      title: "Ensemble's research agent",
      when: "A research or writing task given to Ensemble's own agent.",
      purpose: "Work from real sources, cite them, and write the result to the task's page.",
      body: ownAgentPrompt("research", run, DEFAULT_SETTINGS, "Mira"),
    },
    {
      id: "classifier",
      title: "Triage",
      when: "When an item you chose is passed to triage. Contact sync does not run it.",
      purpose: "Decide whether an email, chat or pull request needs a todo, and who should own it.",
      body: TRIAGE_PROMPT.split("<<ITEMS>>")[0]?.trim() ?? "",
    },
    {
      id: "skill.miner",
      title: "Skill miner",
      when: "After a day's notice, when older work is ready to leave Completed.",
      purpose: "Learn reusable preferences and add them to your personal skills, keeping what they already say. Review and edit them in Skills.",
      body: SKILL_MINING_PROMPT,
    },
  ];
  return cached;
}
