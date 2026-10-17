const SERVICE_DOMAINS = ["amazon.in", "amazon.com", "flipkart.in", "insideapple.com", "updates.notion.com", "nse.co.in", "bseindia.com", "bse.com", "cashify.in", "codeforces.com"];
const AUTOMATED_LOCAL = /^(?:no[._-]?reply|do[._-]?not[._-]?reply|news(?:letter)?|updates?|support|alerts?|notifications?|info|mailer(?:-daemon)?|bounce|calendar-notification)(?:[._+-].*)?$/i;
/** Deterministic sender rules: contact discovery never calls a model. Manual People entries remain available. */
export function nonPerson(address: string, headers: Record<string, string> = {}): boolean {
  const value = address.trim().toLowerCase();
  if (/\[bot\]$|^bot:/.test(value)) return true;
  const at = value.lastIndexOf("@");
  if (at < 0) return false;
  const local = value.slice(0, at), domain = value.slice(at + 1);
  if (AUTOMATED_LOCAL.test(local) || SERVICE_DOMAINS.some(base => domain === base || domain.endsWith(`.${base}`))) return true;
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, val]) => [key.toLowerCase(), val.toLowerCase()]));
  return Boolean(normalized["list-unsubscribe"] || normalized["list-id"] || /bulk|list|junk/.test(normalized.precedence ?? "") || (normalized["auto-submitted"] && normalized["auto-submitted"] !== "no"));
}
