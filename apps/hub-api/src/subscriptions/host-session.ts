/**
 * The variables a Claude host session gives the processes it starts, kept from every agent Ensemble
 * runs (docs/30 §6). The Claude app sets them for the Claude Code session in its Code tab, and that
 * session adds its own marks to every command it runs, so a runtime Claude starts there (`pnpm dev`,
 * `ensemble runner start`) inherits them all. A Claude Code started with them acts as part of the
 * app's session: it waits for the app to sign it in ("Not logged in"), calls itself the app and
 * reaches the app's messaging socket. None of them is a setting of the person's own Claude Code,
 * which reads its sign-in and settings from its own files.
 */

/** Set only by a host or by a Claude Code session for the commands it runs. */
const HOST_SESSION = new Set([
  // Claude Code's marks on each command a session runs.
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_INVOKED_SKILLS",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "AI_AGENT",
  // The app's name for itself, its sign-in and account, and its window's own tools and log.
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_ENTRYPOINT_ON_REQUESTS",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_AUTOUPDATER_DISABLED_BY_HOST",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_SUBSCRIPTION_TYPE",
  "CLAUDE_CODE_RATE_LIMIT_TIER",
  "CLAUDE_CODE_SESSIONS_OAUTH_TOKEN",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_ORGANIZATION_UUID",
  "CLAUDE_CODE_ACCOUNT_UUID",
  "CLAUDE_CODE_USER_EMAIL",
  "CLAUDE_CODE_TERMINAL_MCP_TOOLS",
  "CLAUDE_CODE_DIAGNOSTICS_FILE",
]);

/** Named for the host that sets them: `CLAUDE_CODE_HOST_AUTH_ENV_VAR`, `CLAUDE_CODE_DESKTOP_APP_VERSION`, `CLAUDE_AGENT_SDK_VERSION`. */
const HOST_FAMILIES = ["CLAUDE_CODE_HOST_", "CLAUDE_CODE_DESKTOP_", "CLAUDE_CODE_SDK_HAS_", "CLAUDE_AGENT_SDK_"];

/**
 * Where the app manages the provider (`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`: a gateway or a cloud
 * provider), it removes the person's own `CLAUDE_CODE_USE_*` and writes its own provider, address
 * and model names: these, with the provider's keys and places, are what Claude Code drops when it
 * starts a session outside its host. Anywhere else they are the person's own and pass through.
 */
const HOST_PROVIDER = new Set([
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_GATEWAY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_GOOGLE_CLOUD_PROJECT",
  "ANTHROPIC_GOOGLE_CLOUD_LOCATION",
  "ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_DEFAULT_MODEL",
]);
const HOST_MODEL_NAMES = /^ANTHROPIC_DEFAULT_[A-Z0-9]+_MODEL(_NAME|_DESCRIPTION|_SUPPORTED_CAPABILITIES)?$/;

const truthy = (value: string | undefined): boolean => /^(1|true|yes|on)$/i.test(value?.trim() ?? "");

/** `env` without a Claude host session's own variables, and without the host's provider where the host manages it. */
export function withoutHostSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Names compare in capitals: Windows treats them without case.
  const entries = Object.entries(env).map(([name, value]) => ({ name, upper: name.toUpperCase(), value }));
  const managed = entries.some((entry) => entry.upper === "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST" && truthy(entry.value));
  const kept: NodeJS.ProcessEnv = {};
  for (const { name, upper, value } of entries) {
    if (HOST_SESSION.has(upper) || HOST_FAMILIES.some((family) => upper.startsWith(family))) continue;
    if (managed && (HOST_PROVIDER.has(upper) || HOST_MODEL_NAMES.test(upper))) continue;
    kept[name] = value;
  }
  return kept;
}
