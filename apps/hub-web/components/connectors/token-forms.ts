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
  figma: [
    { ...TOKEN, label: "Personal access token", placeholder: "figd_…" },
    { name: "site", label: "Team link (optional)", placeholder: "https://www.figma.com/files/team/…", minLength: 0 },
  ],
  vercel: [{ ...TOKEN, label: "Access token" }],
  azure_devops: [
    { name: "site", label: "Organization", placeholder: "fieldnote" },
    { ...TOKEN, label: "Personal access token" },
  ],
  zendesk: [
    { name: "site", label: "Zendesk subdomain", placeholder: "fieldnote" },
    { name: "email", label: "Agent email", placeholder: "mira@fieldnote.example", type: "email", minLength: 3 },
    { ...TOKEN, label: "API token" },
  ],
  front: [{ ...TOKEN, label: "API token", placeholder: "eyJ…" }],
  hubspot: [{ ...TOKEN, label: "Private app or service key token", placeholder: "pat-…" }],
};

/** Where to create a token, for providers whose catalog entry has no import.tokenUrl. */
const HELP: Record<string, { url: string; hint: string }> = {
  slack: {
    url: "https://api.slack.com/apps",
    hint: "Create a Slack app, add the user scopes channels:history, groups:history, im:history, mpim:history, channels:read, groups:read, users:read and users:read.email, install it, then copy the User OAuth Token (xoxp-…).",
  },
  figma: {
    url: "https://www.figma.com/settings",
    hint: "Settings → Security → Personal access tokens → Generate new token. Allow reading your user, file content, file comments and projects, and writing file comments to post updates. To search files by name, add your team link (open the team in the sidebar and copy the address).",
  },
  vercel: {
    url: "https://vercel.com/account/settings/tokens",
    hint: "Account Settings → Tokens → Create Token. Choose Full Account to search every team you belong to, or one team.",
  },
  azure_devops: {
    url: "https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate",
    hint: "In Azure DevOps: User settings → Personal access tokens → New Token, for your organization. Scopes: Work Items (Read & write), Code (Read) and Project and Team (Read).",
  },
  zendesk: {
    url: "https://support.zendesk.com/hc/en-us/articles/4408889192858",
    hint: "Admin Center → Apps and integrations → APIs → API tokens → Add API token (an admin turns on token access). Use the email of an agent or admin; internal notes are posted as that person.",
  },
  front: {
    url: "https://dev.frontapp.com/docs/create-and-revoke-api-tokens",
    hint: "Settings → Company → Developers → API tokens → Create API token (needs a Front admin). Give it read access to shared resources, and write access to post internal comments.",
  },
  hubspot: {
    url: "https://developers.hubspot.com/docs/guides/apps/private-apps/overview",
    hint: "Settings → Integrations → Private Apps → Create a private app, or Development → Keys → Service keys. Scopes: crm.objects.contacts.read, crm.objects.companies.read, crm.objects.deals.read, tickets and crm.objects.owners.read; add crm.objects.contacts.write to post notes. Copy the token (pat-…).",
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
