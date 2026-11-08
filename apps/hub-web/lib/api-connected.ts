import { del, get, post } from "./api";

/** One source container mapped to a project ("#design is Project Atlas"). */
export type ProjectLink = {
  id: string;
  projectId: string;
  projectName: string;
  source: string;
  containerId: string;
  containerName: string;
  createdBy: string;
  createdAt: string;
};

/** A container synced artifacts or imports have seen, with the project it is linked to, if any. */
export type SourceContainer = {
  source: string;
  id: string;
  name: string;
  count: number;
  lastSeenAt: string | null;
  projectId: string | null;
  projectName: string | null;
};

export type MeetingPersonRef = { name: string | null; email: string | null };

export type ImportedMeetingNote = {
  id: string;
  title: string;
  source: string;
  sourceLabel: string;
  occurredAt: string;
  summary: string;
  decisions: string[];
  actionItems: Array<{ text: string; owner: MeetingPersonRef | null; mine: boolean; completed: boolean; due: string | null; url: string | null; at?: string | null; taskId?: string | null }>;
  waitingOn: Array<{ text: string; owner: MeetingPersonRef | null }>;
  /** Decisions and action items were found by phrases in what was said, not written by a tool. */
  suggested?: boolean;
  speakers?: string[];
  lineCount?: number;
  durationMinutes?: number | null;
  format?: string | null;
  /** Only on one note (GET /api/meetings/notes/:id). */
  transcript?: Array<{ speaker: string; text: string; at: string | null }>;
  transcriptUrl: string | null;
  event: { id: string; title: string; url: string | null; startsAt: string } | null;
  project: { id: string; name: string } | null;
  people: Array<{ id: string; name: string | null }>;
  tasks: Array<{ id: string; title: string; status: string }>;
  /** Another meeting of the same series can be found. */
  inSeries?: boolean;
  /** The model's read of the meeting (Settings › Automations › Suggest tasks from meetings, or Suggest tasks). */
  aiStatus?: MeetingAiStatus | null;
  aiError?: string | null;
  ai?: MeetingAiRead | null;
};

export type MeetingAiStatus = "queued" | "running" | "done" | "failed" | "skipped";

export type MeetingAiItem = {
  title: string;
  kind: "task" | "deliverable" | "follow_up" | string;
  owner: string | null;
  requestedBy: string | null;
  due: string | null;
  dueText: string | null;
  why: string | null;
  quote: string | null;
  at: string | null;
  details: string | null;
  mine: boolean;
  /** Its quote was found in the meeting; only these become proposed tasks. */
  grounded: boolean;
  task: { id: string; title: string; status: string } | null;
  alreadyTracked: { id: string; title: string | null; status: string | null } | null;
};

export type MeetingAiRead = {
  summary: string;
  decisions: string[];
  openQuestions: string[];
  nextTime: string[];
  newPeople: Array<{ name: string; role: string | null }>;
  project: { name: string; id: string | null; applied: boolean } | null;
  items: MeetingAiItem[];
  model: string | null;
  at: string | null;
};

export type IdentitySuggestion = {
  key: string;
  people: Array<{ id: string; name: string; email: string | null; identities: Array<{ kind: string; value: string }> }>;
  reason: "seen-together" | "same-name" | "handle-matches-email";
  question: string;
  evidence: string;
};

export const LINK_SOURCE_LABEL: Record<string, string> = {
  slack: "Slack channel",
  github: "GitHub repo",
  linear: "Linear",
  jira: "Jira project",
  notion: "Notion database",
  trello: "Trello board",
  asana: "Asana project",
  todoist: "Todoist project",
  clickup: "ClickUp list",
  monday: "monday.com board",
  google_drive: "Drive folder",
  calendar: "Calendar",
  teams: "Teams",
};

export const connectedApi = {
  projectLinks: (projectId?: string) => get<{ links: ProjectLink[] }>(`/api/project-links${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  sourceContainers: (source?: string) => get<{ containers: SourceContainer[] }>(`/api/project-links/containers${source ? `?source=${encodeURIComponent(source)}` : ""}`),
  linkContainer: (input: { projectId: string; source: string; containerId: string; containerName?: string }) =>
    post<{ link: ProjectLink; applied: { artifacts: number; tasks: number } }>("/api/project-links", input),
  unlinkContainer: (id: string) => del<void>(`/api/project-links/${encodeURIComponent(id)}`),
  importedMeetings: () => get<{ notes: ImportedMeetingNote[] }>("/api/meetings/imported"),
  meetingNote: (id: string) => get<{ note: ImportedMeetingNote }>(`/api/meetings/notes/${encodeURIComponent(id)}`),
  identitySuggestions: () => get<{ suggestions: IdentitySuggestion[] }>("/api/people/identity-suggestions"),
  mergePeople: (keepId: string, otherId: string) => post<{ person: { id: string; name: string } }>(`/api/people/${encodeURIComponent(keepId)}/merge`, { otherId }),
  dismissIdentitySuggestion: (personId: string, otherId: string) => post<{ ok: true }>("/api/people/identity-suggestions/dismiss", { personId, otherId }),
};
