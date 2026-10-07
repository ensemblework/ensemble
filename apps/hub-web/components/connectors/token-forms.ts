import type { ConnectorCatalogEntry } from "@ensemble/shared-types";

export type TokenField = {
  /** Body key for POST /api/connectors/:provider/token. */
  name: "token" | "email" | "site" | "key";
  label: string;
  placeholder?: string;
  secret?: boolean;
  type?: "text" | "email";
  minLength?: number;
};

const TOKEN: TokenField = { name: "token", label: "API token", secret: true, minLength: 10 };

/** Fields per provider. Anything not listed pastes a single token. */
const FIELDS: Record<string, TokenField[]> = {
  notion: [{ ...TOKEN, label: "Internal integration secret", placeholder: "ntn_…" }],
  linear: [{ ...TOKEN, label: "Personal API key", placeholder: "lin_api_…" }],
  github: [{ ...TOKEN, label: "Fine-grained token", placeholder: "github_pat_…" }],
  slack: [{ ...TOKEN, label: "User token", placeholder: "xoxp-…" }],
  atlassian: [
    { name: "email", label: "Atlassian account email", placeholder: "mira@fieldnote.example", type: "email", minLength: 3 },
    { ...TOKEN, label: "API token" },
    { name: "site", label: "Site", placeholder: "fieldnote.atlassian.net", minLength: 3 },
  ],
  trello: [
    { name: "key", label: "API key", placeholder: "From your Power-Up admin page", minLength: 10 },
    { ...TOKEN, label: "Token" },
  ],
  asana: [{ ...TOKEN, label: "Personal access token" }],
  todoist: [{ ...TOKEN, label: "API token" }],
  clickup: [{ ...TOKEN, label: "Personal API token", placeholder: "pk_…" }],
  monday: [{ ...TOKEN, label: "Personal API token" }],
  fireflies: [{ ...TOKEN, label: "API key" }],
  fathom: [{ ...TOKEN, label: "API key" }],
  granola: [{ ...TOKEN, label: "API key" }],
  tldv: [{ ...TOKEN, label: "API key" }],
  krisp: [{ ...TOKEN, label: "API key" }],
  jamie: [{ ...TOKEN, label: "API key" }],
  otter: [{ ...TOKEN, label: "API key" }],
};

/** Where to create a token, for providers whose catalog entry has no import.tokenUrl. */
const HELP: Record<string, { url: string; hint: string }> = {
  slack: {
    url: "https://api.slack.com/apps",
    hint: "Create a Slack app, add the user scopes channels:history, groups:history, im:history, mpim:history, users:read and users:read.email, install it, then copy the User OAuth Token (xoxp-…).",
  },
};

export function tokenFields(provider: string | undefined): TokenField[] {
  return (provider && FIELDS[provider]) || [TOKEN];
}

/** Where to get the token: the import spec, then this file, then the entry's docs (meeting tools keep it there). */
export function tokenHelp(entry: Pick<ConnectorCatalogEntry, "provider" | "import" | "docsUrl">): { url?: string; hint?: string } {
  const fallback = entry.provider ? HELP[entry.provider] : undefined;
  return { url: entry.import?.tokenUrl ?? fallback?.url ?? entry.docsUrl, hint: entry.import?.tokenHint ?? fallback?.hint };
}

export function tokenFormReady(fields: readonly TokenField[], values: Record<string, string>): boolean {
  return fields.every((field) => (values[field.name] ?? "").trim().length >= (field.minLength ?? 1));
}
