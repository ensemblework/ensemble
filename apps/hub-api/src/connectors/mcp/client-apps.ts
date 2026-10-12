/**
 * MCP servers that only accept clients registered with the vendor (no dynamic
 * registration). Whoever runs Ensemble registers one client per server, once,
 * and saves it like the other sign-in apps (connector_apps, keyed by `app`).
 * Their redirect URI is the MCP callback, not the connector callback.
 */
import { mcpRedirectUrl } from "./config.js";

export interface McpClientApp {
  app: string;
  label: string;
  console: string;
  steps: readonly string[];
}

export const MCP_CLIENT_APPS: readonly McpClientApp[] = [
  {
    app: "hubspot_mcp",
    label: "HubSpot MCP connector",
    console: "https://app.hubspot.com/developer",
    steps: [
      "HubSpot → Development → MCP Connectors → Create MCP connector.",
      "Redirect URL: the redirect URI below. HubSpot picks the scopes from the tools; nothing to tick.",
      "Paste the connector's client ID and client secret here. Each person picks their own HubSpot account when they connect.",
    ],
  },
  {
    app: "asana_mcp",
    label: "Asana MCP app",
    console: "https://app.asana.com/0/my-apps",
    steps: [
      "Asana → My apps → Create new app → MCP app. Distribution: Any workspace.",
      "Redirect URL: the redirect URI below. Leave scopes empty; Asana's MCP server asks for what its tools need.",
      "Paste the client ID and client secret here.",
    ],
  },
  {
    app: "slack_mcp",
    label: "Slack MCP app",
    console: "https://api.slack.com/apps",
    steps: [
      "Slack only lets apps that are published in the Slack Marketplace, or used inside their own workspace, use its MCP server.",
      "Set up the Slack app for Slack's MCP server as Slack's guide describes (docs.slack.dev/ai/slack-mcp-server), and add the redirect URI below under OAuth & Permissions → Redirect URLs.",
      "Paste the app's client ID and client secret here.",
    ],
  },
  {
    app: "dropbox_mcp",
    label: "Dropbox MCP client",
    console: "https://www.dropbox.com/developers/apps",
    steps: [
      "Use the same Dropbox app as the Dropbox connector, or create one: Scoped access, Full Dropbox.",
      "Permissions: files.metadata.read, files.content.read, files.content.write, sharing.read, sharing.write, account_info.read. Settings → Redirect URIs: add the redirect URI below.",
      "Paste the App key and App secret here. After 50 people link it, Dropbox gives two weeks to apply for production status.",
    ],
  },
];

export function mcpClientApp(app: string): McpClientApp | undefined {
  return MCP_CLIENT_APPS.find((row) => row.app === app);
}

export function mcpClientAppView(row: McpClientApp) {
  return { provider: row.app, label: row.label, redirectUri: mcpRedirectUrl(), console: row.console, steps: [...row.steps] };
}
