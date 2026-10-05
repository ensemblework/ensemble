/**
 * Credential environment that must never reach an agent command.
 *
 * `ENSEMBLE_GIT_TOKEN` used to ride in with `useCredentials` (`git-auth.ts`
 * askpass). The sandboxed child could print it. The token stays in the app's
 * own git process. This scrub is the backstop if a caller still passes it.
 */

export const CREDENTIAL_ENV_KEYS = [
  "ENSEMBLE_GIT_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_SECRET",
];

function credentialKey(key: string): boolean {
  if (CREDENTIAL_ENV_KEYS.includes(key)) return true;
  if (/^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(key)) return true;
  if (key === "GIT_TERMINAL_PROMPT") return false;
  return /(TOKEN|SECRET|PASSWORD|CREDENTIAL|ASKPASS)/i.test(key);
}

/** Drop every credential variable. Agents also get a dead askpass and no SSH. */
export function scrubAgentEnv(env: NodeJS.ProcessEnv, who: "agent" | "human"): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (credentialKey(key)) continue;
    next[key] = value;
  }
  if (who === "agent") {
    next.GIT_ASKPASS = "/usr/bin/false";
    next.SSH_ASKPASS = "/usr/bin/false";
    next.GIT_SSH_COMMAND = "ssh -o BatchMode=yes -F /dev/null";
    next.GIT_TERMINAL_PROMPT = "0";
  }
  return next;
}

export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join("[redacted]");
  }
  return out;
}
