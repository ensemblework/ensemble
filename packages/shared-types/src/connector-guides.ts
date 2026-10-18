/**
 * Step-by-step connect guides for the connector store's detail page, written
 * for people who have never made an API token. Each guide uses the vendor's
 * own name for the thing that is pasted (`term`), and the store's field label
 * uses the same words, so the guide, the form and the vendor's page agree.
 *
 * URLs are ones the catalog or token forms already link to, or vendor home
 * pages. Each step holds at most one URL.
 */
import type { ConnectorCatalogEntry } from "./connectors.js";

export interface ConnectorGuide {
  /** The vendor's own name for what is pasted, e.g. "internal integration secret". */
  term?: string;
  title?: string;
  /** Short imperative steps, in order. Each may contain one https:// URL. */
  steps: readonly string[];
  whereToFind?: string;
  /** What a correct value looks like, e.g. 'Starts with "ntn_".' */
  looksLike?: string;
  /** The usual wrong thing people paste. */
  notThis?: string;
  /** Permissions or plan the credential needs. */
  scopes?: string;
}

/**
 * Guides for every connector that takes a pasted credential: the token
 * providers (hub-api connectors/token-providers.ts) and the MCP servers that
 * take a token, address fields or the person's own registered app.
 */
export const CONNECTOR_GUIDES: Readonly<Record<string, ConnectorGuide>> = {
  notion: {
    term: "internal integration secret",
    title: "Create a Notion internal integration secret",
    steps: [
      "Open https://www.notion.so/profile/integrations and sign in to Notion.",
      "Click New integration.",
      "Name it Ensemble, choose your workspace, keep the type Internal, and click Save.",
      "On the integration's Configuration tab, next to Internal integration secret, click Show, then Copy.",
      "Paste it into Internal integration secret below.",
      "Back in Notion, open each top-level page Ensemble may read, click ••• at the top right → Connections, and add your integration. Pages inside it come too.",
    ],
    looksLike: 'Starts with "ntn_". Older secrets start with "secret_".',
    notThis: "The OAuth client secret of a public integration. Use the internal integration secret from the Configuration tab.",
    scopes:
      "Under Capabilities, Read content is required. Update content, Insert content and Insert comments let Ensemble write pages and post updates after your Apply. Read user information including email addresses lets it add your Notion people to People.",
  },
  linear: {
    term: "personal API key",
    title: "Create a Linear personal API key",
    steps: [
      "Open https://linear.app/settings/account/security and sign in to Linear.",
      "Under Personal API keys, click New API key.",
      "Name it Ensemble. If Linear asks for permissions and teams, choose Read and Write and the teams Ensemble should see.",
      "Click Create, then copy the key. Linear shows it only once.",
      "Paste it into Personal API key below.",
    ],
    looksLike: 'Starts with "lin_api_".',
    notThis: "An OAuth application's client secret or a webhook signing secret.",
    scopes: "Write access lets Ensemble post updates as comments, only when you press Post or Apply.",
  },
  github: {
    term: "fine-grained personal access token",
    title: "Create a GitHub fine-grained personal access token",
    steps: [
      "Open https://github.com/settings/personal-access-tokens/new and sign in to GitHub.",
      "Name it Ensemble and pick an expiration date.",
      "Under Resource owner, choose your account, or the organization that owns the repositories.",
      "Under Repository access, choose All repositories or Only select repositories.",
      "Under Permissions, add Contents (Read-only), Issues (Read and write) and Pull requests (Read and write).",
      "Click Generate token, then copy it. GitHub shows it only once.",
      "Paste it into Fine-grained personal access token below.",
    ],
    looksLike: 'Starts with "github_pat_".',
    notThis: "The token's name, or an SSH key. Copy the long value GitHub shows once, right after you click Generate token.",
    scopes: "Contents lets agents clone the repositories; Issues and Pull requests let Ensemble post updates after your Apply. Some organizations approve fine-grained tokens before they work on their repositories.",
  },
  slack: {
    term: "user OAuth token",
    title: "Create a Slack app and copy its user OAuth token",
    steps: [
      "Open https://api.slack.com/apps and sign in to your Slack workspace.",
      "Click Create New App → From scratch, name it Ensemble, pick your workspace, and click Create App.",
      "Open OAuth & Permissions. Under User Token Scopes (not Bot Token Scopes), add the scopes listed below.",
      "Scroll up, click Install to Workspace, then Allow. Some workspaces need an admin to approve the app first.",
      "Copy the User OAuth Token shown on the same page.",
      "Paste it into User OAuth token below.",
    ],
    looksLike: 'Starts with "xoxp-".',
    notThis: 'The Bot User OAuth Token (starts with "xoxb-"), or the app\'s Client Secret or Signing Secret.',
    scopes: "channels:history, groups:history, im:history, mpim:history, channels:read, groups:read, users:read and users:read.email.",
  },
  atlassian: {
    term: "API token",
    title: "Create an Atlassian API token for Jira and Confluence",
    steps: [
      "Open https://id.atlassian.com/manage-profile/security/api-tokens and sign in to Atlassian.",
      "Click Create API token (the plain one, not Create API token with scopes).",
      "Name it Ensemble, choose when it expires, and click Create.",
      "Copy the token. Atlassian shows it only once.",
      "Below, enter the email you sign in to Atlassian with, paste the API token, and enter your site: the start of your Jira address, like yourteam.atlassian.net.",
    ],
    looksLike: 'Starts with "ATATT".',
    notThis: "Your Atlassian password. Jira takes the API token together with your email.",
  },
  trello: {
    term: "API key and token",
    title: "Get a Trello API key and token",
    steps: [
      "Open https://trello.com/power-ups/admin and sign in to Trello.",
      "Open your Power-Up. If you have none, click New, name it Ensemble, choose your Workspace, fill in the other required fields and click Create.",
      "Open the API key tab. If no key shows yet, click Generate a new API key.",
      "Copy the API key and paste it into API key below.",
      "Click Get a token below (or the Token link next to your API key on Trello's page).",
      "Trello asks whether to let Ensemble use your account. Click Allow.",
      "Copy the token Trello shows. It starts with ATTA. Paste it into Token below.",
    ],
    looksLike: 'The API key is 32 letters and numbers. The token starts with "ATTA".',
    notThis: "The Secret on the API key tab. It is for a different kind of sign-in, and Trello refuses it as a token.",
    scopes: "Read and write. Write lets Ensemble post updates as card comments, only when you press Post or Apply.",
  },
  asana: {
    term: "personal access token",
    title: "Create an Asana personal access token",
    steps: [
      "Open https://app.asana.com/0/my-apps and sign in to Asana.",
      "Under Personal access tokens, click Create new token.",
      "Name it Ensemble, agree to Asana's API terms, and click Create token.",
      "Copy the token. Asana shows it only once.",
      "Paste it into Personal access token below.",
    ],
    looksLike: 'Starts with "2/" (older tokens with "1/"), then numbers, letters and a colon.',
    notThis: "The client secret of an app in the same developer console.",
  },
  todoist: {
    term: "API token",
    title: "Copy your Todoist API token",
    steps: [
      "Open https://app.todoist.com/app/settings/integrations/developer and sign in to Todoist.",
      "Under API token, click Copy API token.",
      "Paste it into API token below.",
    ],
    looksLike: "40 letters and numbers.",
    notThis: "The client secret of an app you built under Build integrations.",
  },
  clickup: {
    term: "personal API token",
    title: "Create a ClickUp personal API token",
    steps: [
      "Open https://app.clickup.com/settings/apps and sign in to ClickUp.",
      "Under API Token, click Generate (or Copy, if you already have one).",
      "Paste it into Personal API token below.",
    ],
    looksLike: 'Starts with "pk_".',
    notThis: "The Client ID or Client Secret of an app on the same page.",
  },
  monday: {
    term: "personal API token",
    title: "Copy your monday.com personal API token",
    steps: [
      "Sign in to monday.com at https://auth.monday.com/users/sign_in.",
      "Click your profile picture at the top right → Developers.",
      "Open My access tokens, click Show, then copy the token.",
      "Paste it into Personal API token below.",
    ],
    looksLike: 'A long code that starts with "eyJ".',
    notThis: "An app's Client secret or Signing secret from the Developer center.",
  },
  figma: {
    term: "personal access token",
    title: "Create a Figma personal access token",
    steps: [
      "Open https://www.figma.com/settings and sign in to Figma.",
      "Open the Security tab and find Personal access tokens.",
      "Click Generate new token, name it Ensemble, and pick an expiry (up to 90 days).",
      "Choose the scopes listed below, then click Generate token.",
      "Copy the token. Figma shows it only once.",
      "Paste it into Personal access token below. To search your team's files by name, also paste your team link: open the team in Figma's sidebar and copy the address.",
    ],
    looksLike: 'Starts with "figd_".',
    notThis: "A file link. The team link goes in its own field; the token comes from Settings → Security.",
    scopes: "Read your user, file content, file comments and projects. Write file comments to post updates.",
  },
  vercel: {
    term: "access token",
    title: "Create a Vercel access token",
    steps: [
      "Open https://vercel.com/account/settings/tokens and sign in to Vercel.",
      "Under Create Token, name it Ensemble.",
      "Choose the scope: Full Account to see every team you belong to, or one team.",
      "Pick an expiration and click Create.",
      "Copy the token. Vercel shows it only once.",
      "Paste it into Access token below.",
    ],
    notThis: "A deploy hook URL or a project's environment variable.",
  },
  azure_devops: {
    term: "personal access token",
    title: "Create an Azure DevOps personal access token",
    steps: [
      "Sign in at https://dev.azure.com and open your organization.",
      "Click User settings (the person icon at the top right) → Personal access tokens.",
      "Click New Token, name it Ensemble, and choose your organization.",
      "Under Scopes, choose Custom defined and tick the scopes listed below.",
      "Click Create, then copy the token. Azure DevOps shows it only once.",
      "Below, enter your organization (the name after dev.azure.com/) and paste the personal access token.",
    ],
    notThis: "A token for All accessible organizations. Those global tokens stop working on 1 Dec 2026.",
    scopes: "Work Items: Read & write, Code: Read, and Project and Team: Read.",
    whereToFind: "Microsoft's guide: https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate",
  },
  zendesk: {
    term: "API token",
    title: "Create a Zendesk API token",
    steps: [
      "Sign in to Zendesk as an admin and open Admin Center.",
      "Go to Apps and integrations → APIs → API tokens. If token access is off, turn it on.",
      "Click Add API token, describe it as Ensemble, and click Save.",
      "Copy the token. Zendesk shows it only once.",
      "Below, enter your Zendesk subdomain (the part before .zendesk.com), the email of an agent or admin, and paste the API token.",
    ],
    notThis: "An end user's email. Internal notes are posted as the agent whose email you enter.",
    whereToFind: "Zendesk's guide: https://support.zendesk.com/hc/en-us/articles/4408889192858",
  },
  front: {
    term: "API token",
    title: "Create a Front API token",
    steps: [
      "Sign in to Front as an admin.",
      "Open Settings → Company → Developers → API tokens.",
      "Click Create API token and name it Ensemble.",
      "Give it read access to shared resources, and write access to post internal comments.",
      "Create it, then copy the token.",
      "Paste it into API token below.",
    ],
    looksLike: 'A long code that starts with "eyJ".',
    notThis: "The client secret of a Front developer app. That is only for Front's MCP tools.",
    whereToFind: "Front's guide: https://dev.frontapp.com/docs/create-and-revoke-api-tokens",
  },
  hubspot: {
    term: "service key",
    title: "Create a HubSpot service key",
    steps: [
      "Sign in to HubSpot as a super admin, or someone with developer access.",
      "Go to Development → Keys → Service keys and create a key. In older accounts: Settings → Integrations → Private Apps → Create a private app.",
      "Add the scopes listed below.",
      "Create it, then copy the key (or the private app's access token).",
      "Paste it into Service key or private app access token below.",
    ],
    looksLike: 'Private app access tokens start with "pat-".',
    notThis: "A private app's client secret, or a developer API key.",
    scopes:
      "crm.objects.contacts.read, crm.objects.companies.read, crm.objects.deals.read, tickets and crm.objects.owners.read. Add crm.objects.contacts.write to post notes.",
    whereToFind: "HubSpot's guide: https://developers.hubspot.com/docs/guides/apps/private-apps/overview",
  },
  zotero: {
    term: "API key",
    title: "Create a Zotero API key",
    steps: [
      "Open https://www.zotero.org/settings/keys/new and sign in to zotero.org.",
      "Name the key Ensemble.",
      "Under Personal Library, tick Allow library access. Tick Allow notes access to include notes, and Allow write access to post notes from Ensemble.",
      "To include group libraries, set Default Group Permissions to Read Only (or Read/Write).",
      "Click Save Key, then copy the key. Zotero shows it only once.",
      "Paste it into API key below.",
    ],
    looksLike: "24 letters and numbers.",
    notThis: "Your user ID (the number on the same page) or your zotero.org password.",
  },
  // Meeting-note apps: the key imports notes you ask for into Meetings.
  granola: {
    term: "API key",
    title: "Create a Granola API key",
    steps: [
      "Open the Granola app on your computer.",
      "Go to Settings → Connectors → API keys.",
      "Create a key, then copy it.",
      "Paste it into API key below.",
    ],
    scopes: "API keys need Granola's Business plan or above. On other plans, Connect tools (Granola's MCP server) works instead.",
    whereToFind: "Granola's docs: https://docs.granola.ai/introduction",
  },
  fireflies: {
    term: "API key",
    title: "Copy your Fireflies.ai API key",
    steps: [
      "Open https://app.fireflies.ai/integrations/custom/fireflies and sign in to Fireflies.",
      "Copy your API key (generate one if none is shown).",
      "Paste it into API key below.",
    ],
    scopes: "The free plan allows about 50 API requests a day; each meeting import uses one or two.",
  },
  fathom: {
    term: "API key",
    title: "Create a Fathom API key",
    steps: [
      "Open https://fathom.video/customize#api-access-header and sign in to Fathom.",
      "Under API Access, create a new API key, then copy it.",
      "Paste it into API key below.",
    ],
    scopes: "The free plan includes one key. A key sees meetings you recorded or that were shared with you or your team.",
  },
  tldv: {
    term: "API key",
    title: "Create a tl;dv API key",
    steps: [
      "Open https://tldv.io/app/settings/personal-settings/api-keys and sign in to tl;dv.",
      "Create a new API key, then copy it.",
      "Paste it into API key below.",
    ],
    scopes: "Only meetings whose organiser has a Pro, Business or Enterprise plan are returned.",
  },
  krisp: {
    term: "API key",
    title: "Create a Krisp API key",
    steps: ["Sign in to Krisp and open Integrations → API.", "Create a key with Read access, then copy it.", "Paste it into API key below."],
    scopes: "Personal API keys need the Core or Advanced plan.",
    whereToFind: "Krisp's docs: https://meeting-api-docs.krisp.ai/docs/getting-started",
  },
  jamie: {
    term: "API key",
    title: "Create a Jamie API key",
    steps: ["Open Jamie and go to Settings → Developers → API Keys.", "Create a personal key, then copy it.", "Paste it into API key below."],
    looksLike: 'Starts with "jk_".',
    scopes: "Needs the Pro, Team or Enterprise plan.",
    whereToFind: "Jamie's docs: https://docs.meetjamie.ai/developers/api/api",
  },
  otter: {
    term: "API key",
    title: "Create an Otter.ai API key",
    steps: ["Sign in to Otter and open Integrations → Developer.", "Create an API key, then copy it.", "Paste it into API key below."],
    scopes: "Only Enterprise workspaces have API keys. On other plans, Connect tools (Otter's MCP server) lets the assistant search your meetings.",
    whereToFind: "Otter's guide: https://help.otter.ai/hc/en-us/articles/36130822688279-Otter-ai-Public-API",
  },
  // Vendor MCP servers that take a token.
  render: {
    term: "API key",
    title: "Create a Render API key",
    steps: [
      "Sign in to Render at https://dashboard.render.com.",
      "Open Account Settings → API Keys.",
      "Click Create API Key, name it Ensemble, and create it.",
      "Copy the key.",
      "Paste it into Render API key below and click Connect with token.",
      "Choose which tools the assistant may use.",
    ],
    looksLike: 'Starts with "rnd_".',
    scopes: "The key acts as your whole Render account. Tools that change things still wait for your Apply.",
    whereToFind: "Render's docs: https://render.com/docs/api",
  },
  smartsheet: {
    term: "API access token",
    title: "Create a Smartsheet API access token",
    steps: [
      "Sign in to Smartsheet at https://app.smartsheet.com.",
      "Open your account menu → Personal Settings (in newer layouts, Apps & Integrations) → API Access.",
      "Click Generate new access token, name it Ensemble, and confirm.",
      "Copy the token. Smartsheet shows it only once.",
      "Paste it into Smartsheet API access token below and click Connect with token.",
    ],
    whereToFind: "Smartsheet's guide: https://developers.smartsheet.com/api/smartsheet/guides/basics/authentication",
  },
  wrike: {
    term: "permanent access token",
    title: "Create a Wrike permanent access token",
    steps: [
      "Sign in to Wrike at https://www.wrike.com.",
      "Click your profile picture → Apps & Integrations → API.",
      "Create an app (any name, like Ensemble).",
      "Under Permanent access token, click Create token and confirm.",
      "Copy the token, then paste it into Wrike permanent access token below and click Connect with token.",
    ],
    whereToFind: "Wrike's developer docs: https://developers.wrike.com/",
  },
  intercom: {
    term: "access token",
    title: "Copy an Intercom access token",
    steps: [
      "Sign in to Intercom and open the Developer Hub.",
      "Open your app, or create one for your own workspace.",
      "Open Authentication and copy the Access token.",
      "Paste it into Intercom access token below and click Connect with token.",
    ],
    notThis: "An app's client secret. The access token acts in your own Intercom workspace.",
    whereToFind: "Intercom's guide: https://developers.intercom.com/docs/build-an-integration/learn-more/authentication",
  },
  stripe: {
    term: "agent API key",
    title: "Connect Stripe",
    steps: [
      "Easiest: click Sign in with Stripe, sign in and approve access for Ensemble.",
      "To use a key instead, open https://dashboard.stripe.com/apikeys.",
      "Create an agent API key, then copy it.",
      "Click Paste an agent API key, paste the key, and click Connect with token.",
    ],
    notThis: 'Your publishable key (starts with "pk_"). Stripe\'s MCP server refuses other secret keys from 31 Oct 2026.',
  },
  cloudflare: {
    term: "API token",
    title: "Connect Cloudflare",
    steps: [
      "Easiest: click Sign in with Cloudflare, sign in and approve access for Ensemble.",
      "To use a token instead, open https://dash.cloudflare.com/profile/api-tokens.",
      "Click Create Token, start from a template or Create Custom Token, and give it only the permissions the assistant should have.",
      "Click Continue to summary, then Create Token, and copy it.",
      "Click Paste an API token, paste it, and click Connect with token.",
    ],
    notThis: "Your Global API Key. An API token can be limited; the global key cannot.",
  },
  huggingface: {
    term: "access token",
    title: "Connect Hugging Face",
    steps: [
      "Easiest: click Sign in with Hugging Face, sign in and approve access for Ensemble.",
      "To use a token instead, open https://huggingface.co/settings/tokens.",
      "Click Create new token, choose Read (Write only if the assistant should create repos), name it Ensemble, and create it.",
      "Copy the token.",
      "Click Paste an access token, paste it, and click Connect with token.",
    ],
    looksLike: 'Starts with "hf_".',
    scopes: "A Read token is enough to search and read your models, datasets and Spaces.",
    whereToFind: "Pick extra tools and Spaces at https://huggingface.co/settings/mcp, then press Refresh tools here.",
  },
  // Vendor MCP servers that need an address or the person's own app.
  grafana: {
    title: "Connect Grafana Cloud",
    steps: [
      "Find your Grafana Cloud address, like fieldnote.grafana.net: it is where you open Grafana.",
      "Type the first part (fieldnote) into Your Grafana Cloud stack below.",
      "Click Connect tools. Grafana's page opens: sign in and approve access.",
      "Back here, choose which tools the assistant may use.",
    ],
    notThis: 'The whole address. Type only the part before ".grafana.net".',
    scopes: "Grafana Assistant must be on for the stack, and you need the Cloud MCP User role (editors have it).",
  },
  aws_account: {
    title: "Connect your AWS account",
    steps: [
      "Sign in to the AWS console at https://console.aws.amazon.com.",
      "Note the Region code at the top right, like us-east-1 (open the Region menu to see codes).",
      "Type it into AWS Region below.",
      "Click Connect tools. AWS's sign-in page opens: sign in and approve.",
      "Back here, choose which tools the assistant may use.",
    ],
    notThis: "The Region's name, like US East (N. Virginia). Type the code, like us-east-1.",
    scopes: "Your IAM user or role needs the AWSMCPSignInOAuthAccessPolicy policy. AWS sign-ins last 12 hours, so expect to reconnect.",
  },
  salesforce: {
    title: "Connect Salesforce with your organization's app",
    steps: [
      "Ask your Salesforce admin to turn on the sobject-all MCP server (Setup → MCP Servers).",
      "They create an External Client App with the redirect address shown below, the scopes mcp_api and refresh_token, and PKCE turned on.",
      "Copy the app's consumer key and consumer secret, and paste them below.",
      "Click Connect tools. Salesforce's page opens: sign in and approve.",
      "Back here, choose which tools the assistant may use.",
    ],
    scopes: "Needs Salesforce Enterprise Edition or above.",
    whereToFind: "Salesforce's guide: https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/create-external-client-app.html",
  },
};

/** Tips for the Import section, separate from connecting. */
export const IMPORT_TIPS: Readonly<Record<string, string>> = {
  trello: "No token needed for a one-off import: open the board menu (•••) → Print, export and share → Export as JSON, then upload the file.",
};

export type ConnectWay = "oauth" | "token" | "mcp";

type GuideEntry = Pick<ConnectorCatalogEntry, "id" | "name" | "vendor" | "auth" | "provider" | "products" | "mcp">;

/** The short name people use: "Notion", not "Notion Labs"; "Atlassian" for Jira; "Hugging Face" whole. */
function brandOf(entry: Pick<ConnectorCatalogEntry, "name" | "vendor">): string {
  if (entry.vendor === entry.name) return entry.name;
  const first = entry.name.split(" ")[0];
  return entry.vendor.split(" ")[0] === first && first ? first : entry.vendor;
}

const APPROVE = "the button may say Allow, Accept or Authorize";

/** What sign-in asks of the person, beyond the usual approve. */
const SIGN_IN_EXTRA: Readonly<Record<string, string>> = {
  google_workspace: "Check what Ensemble asks for and approve. If Google shows a box for each permission, tick them all: an unticked box leaves that product off.",
  microsoft_365: "Check what Ensemble asks for and click Accept. If Microsoft says an admin must approve, ask your IT admin to approve Ensemble, then try again.",
  notion: "Notion asks which pages Ensemble may use. Pick them (pages inside come too), then allow access.",
  discord: "Choose the server to add Ensemble's bot to, then click Authorize. The bot reads only channels it can see.",
};

function signInGuide(entry: GuideEntry): ConnectorGuide {
  const who = brandOf(entry);
  const extra = SIGN_IN_EXTRA[entry.id];
  return {
    title: "What happens when you sign in",
    steps: [
      ...(entry.products?.length ? ["Switch on what Ensemble may use. You can change this later."] : []),
      entry.provider === "google" ? "Click Sign in with Google." : "Click Connect.",
      `${who}'s page opens. Sign in with the account you want to connect.`,
      extra ?? `Check what Ensemble asks for, then approve (${APPROVE}).`,
      "You come straight back here, connected.",
    ],
  };
}

function mcpGuide(entry: GuideEntry): ConnectorGuide {
  const who = brandOf(entry);
  const choose = `Back here, choose which tools the assistant may use. Tools that change ${who} wait for your Apply.`;
  if (entry.mcp?.connection) {
    return {
      title: `Use ${who}'s tools with your connection`,
      steps: [`Connect ${who} first (sign in, or paste a token).`, `Click Use your ${who} connection.`, choose],
    };
  }
  if (entry.mcp?.open) {
    return {
      title: "What happens when you connect",
      steps: ["Click Connect tools.", `No ${who} account is needed: the server holds only public information.`, choose],
    };
  }
  if (entry.mcp?.ownClient) {
    return {
      title: `Connect ${who}'s tools with your organization's app`,
      steps: [
        `Ask your ${who} admin to create an app for Ensemble, as described below.`,
        "Paste its client ID and client secret below, then click Connect tools.",
        `${who}'s page opens. Sign in and approve access for Ensemble.`,
        choose,
      ],
    };
  }
  return {
    title: "What happens when you connect",
    steps: ["Click Connect tools.", `${who}'s page opens. Sign in and approve access for Ensemble (${APPROVE}).`, choose],
  };
}

/**
 * The guide for one way of connecting an entry. Pasted credentials and MCP
 * servers with a token, address or own app get their written guide; sign-in
 * gets a short "what happens" guide.
 */
export function connectorGuide(entry: GuideEntry, way: ConnectWay): ConnectorGuide | undefined {
  const written = CONNECTOR_GUIDES[entry.id];
  if (way === "token") return entry.auth.includes("token") ? written : undefined;
  if (way === "mcp") {
    if (!entry.mcp) return undefined;
    return written && !entry.auth.includes("token") ? written : mcpGuide(entry);
  }
  return entry.auth.includes("oauth") ? signInGuide(entry) : undefined;
}

/** True when this way has a written guide (not the short sign-in one). */
export function hasWrittenGuide(entry: GuideEntry, way: ConnectWay): boolean {
  const written = CONNECTOR_GUIDES[entry.id];
  return Boolean(written) && connectorGuide(entry, way) === written;
}

const URL_PATTERN = /https:\/\/[^\s)]+[^\s).,;:]/g;

/** Every URL in a guide, for checks and link rendering. */
export function guideUrls(guide: ConnectorGuide): string[] {
  return [...guide.steps, guide.whereToFind ?? "", guide.looksLike ?? "", guide.notThis ?? "", guide.scopes ?? ""].flatMap((text) => text.match(/\bhttps?:\/\/[^\s)]+[^\s).,;:]/g) ?? []);
}

/** Splits text into plain parts and https links, for rendering steps with clickable addresses. */
export function guideParts(text: string): Array<{ text: string; href?: string }> {
  const parts: Array<{ text: string; href?: string }> = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: match[0].replace(/^https:\/\//, "").replace(/\/$/, ""), href: match[0] });
    last = start + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
