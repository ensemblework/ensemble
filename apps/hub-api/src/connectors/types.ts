import type { Settings } from "@ensemble/shared-types";
import type { StoredArtifact } from "./ingest.js";

export interface SyncContext {
  userId: string;
  settings: Settings;
  /** Read from here: the last successful sync, or the look-back window after a gap. */
  since: Date;
  cursor: string | null;
}

/** A todo a connector can propose without asking a model (assigned issue, review request). */
export interface Proposal {
  sourceRef: string;
  sourceKind: "email" | "slack" | "meeting" | "github" | "linear" | "other";
  title: string;
  description: string;
  sourceUrl?: string | null;
  excerpt?: string | null;
  priority: "p0" | "p1" | "p2";
  due?: Date | null;
  people?: string[];
  repoId?: string | null;
  artifactId: string;
  rationale: string;
}

export interface SyncResult {
  items: number;
  stored: StoredArtifact[];
  proposals: Proposal[];
  /** New artifacts that need a model to decide whether they ask something of the engineer. */
  triage: Array<StoredArtifact & { personId?: string | null }>;
  cursor?: string | null;
  account?: string | null;
}

export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly needsReconnect = false,
  ) {
    super(message);
  }
}

export async function readJson<T>(response: Response, label: string): Promise<T> {
  if (response.status === 401 || response.status === 403) {
    const detail = (await response.text()).slice(0, 200);
    throw new ConnectorError(`${label} refused access (${response.status}). Reconnect it. ${detail}`, true);
  }
  if (response.status === 429) {
    throw new ConnectorError(`${label} is rate limiting. Try again in ${response.headers.get("retry-after") ?? "a few"} seconds.`);
  }
  if (!response.ok) throw new ConnectorError(`${label} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return (await response.json()) as T;
}
