import type { ConnectorCatalogEntry } from "@ensemble/shared-types";

export type TokenField = {
  /** Body key for POST /api/connectors/:provider/token. */
  name: "token" | "email" | "site" | "key";
  label: string;
  placeholder?: string;
  secret?: boolean;
  type?: "text" | "email";
  minLength?: number;
  /** A button beside the field that opens the vendor's page, built from what is typed so far. A null href keeps it disabled with `hint`. */
  link?: { label: string; href: (values: Readonly<Record<string, string>>) => string | null; hint: string };
};

const TOKEN: TokenField = { name: "token", label: "API token", secret: true, minLength: 10 };

/** Fields per provider. Anything not listed pastes a single token. */
const FIELDS: Record<string, TokenField[]> = {
  notion: [{ ...TOKEN, label: "Internal integration secret", placeholder: "ntn_…" }],
  linear: [{ ...TOKEN, label: "Personal API key", placeholder: "lin_api_…" }],
  github: [{ ...TOKEN, label: "Fine-grained personal access token", placeholder: "github_pat_…" }],
  slack: [{ ...TOKEN, label: "User OAuth token", placeholder: "xoxp-…" }],
  atlassian: [
    { name: "email", label: "Atlassian account email", placeholder: "mira@fieldnote.example", type: "email", minLength: 3 },
    { ...TOKEN, label: "API token" },
    { name: "site", label: "Site", placeholder: "fieldnote.atlassian.net", minLength: 3 },
  ],
  trello: [
    { name: "key", label: "API key", placeholder: "32 letters and numbers, from your Power-Up's API key tab", minLength: 10 },
    {
      ...TOKEN,
      label: "Token (from the Token link, starts with ATTA)",
      placeholder: "ATTA…",
      link: { label: "Get a token", href: (values) => trelloTokenUrl(values.key), hint: "Enter your API key first." },
    },
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
  hubspot: [{ ...TOKEN, label: "Service key or private app access token", placeholder: "pat-…" }],
  zotero: [{ ...TOKEN, label: "API key", placeholder: "24 letters and digits" }],
};

/** Where to create a token, for providers whose catalog entry has no import.tokenUrl. */
/** The step-by-step detail lives in CONNECTOR_GUIDES (shared types); `hint` is shown only where a provider has no guide. */
const HELP: Record<string, { url: string; hint?: string }> = {
  slack: { url: "https://api.slack.com/apps" },
  figma: { url: "https://www.figma.com/settings" },
  vercel: { url: "https://vercel.com/account/settings/tokens" },
  azure_devops: { url: "https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate" },
  zendesk: { url: "https://support.zendesk.com/hc/en-us/articles/4408889192858" },
  front: { url: "https://dev.frontapp.com/docs/create-and-revoke-api-tokens" },
  hubspot: { url: "https://developers.hubspot.com/docs/guides/apps/private-apps/overview" },
  fireflies: { url: "https://app.fireflies.ai/integrations/custom/fireflies" },
  fathom: { url: "https://fathom.video/customize#api-access-header" },
  tldv: { url: "https://tldv.io/app/settings/personal-settings/api-keys" },
  zotero: {
    url: "https://www.zotero.org/settings/keys/new",
    hint: "Sign in to zotero.org and create a new private key. Under Personal Library tick Allow library access and Allow notes access; add Allow write access to save notes from Ensemble. Set Default Group Permissions to Read Only to include group libraries. Save, then copy the key. Ensemble sees what Zotero has synced to zotero.org.",
  },
};

/**
 * Trello's own authorize page for this API key: after Allow it shows a token (ATTA…).
 * Write scope lets Ensemble post updates as card comments.
 */
export function trelloTokenUrl(key: string | undefined): string | null {
  const value = (key ?? "").trim();
  if (!/^[A-Za-z0-9]{16,128}$/.test(value) || /^ATTA/i.test(value)) return null;
  return `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=Ensemble&key=${encodeURIComponent(value)}`;
}

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
