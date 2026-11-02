/**
 * Known failures in a command's output, and what to do instead (docs/35 §8.16.4): added to the note
 * that wakes a node when its background command ends. One row per failure; add rows here.
 */

const GUID = "[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}";
/** A tenant as the Azure CLI lists it: `<id> 'Name'`, or on a line that says tenant. */
const TENANT = new RegExp(`^\\s*(${GUID})\\s+'|tenant[^\\n]*?\\b(${GUID})\\b`, "im");

type Hint = { pattern: RegExp; hint: (output: string) => string | null };

const HINTS: Hint[] = [
  {
    pattern: /AADSTS530035/,
    hint: () => "Device-code sign-in is blocked by this account's security defaults: run plain `az login` (browser sign-in) instead.",
  },
  {
    pattern: /No subscriptions found/i,
    hint: (output) => {
      const found = TENANT.exec(output);
      const tenant = found?.[1] ?? found?.[2];
      return tenant ? `It signed in, but found no subscription to use: run \`az login --tenant ${tenant}\`, and \`az account list --all\` to see every subscription.` : null;
    },
  },
];

export function signInHints(output: string): string[] {
  const hints: string[] = [];
  for (const row of HINTS) {
    if (!row.pattern.test(output)) continue;
    const hint = row.hint(output);
    if (hint) hints.push(hint);
  }
  return hints;
}
