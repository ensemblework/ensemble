import { prisma } from "../lib/prisma.js";
import { syncAccount } from "./tokens.js";
import { parseAddressList, upsertPerson } from "./ingest.js";
import { readJson, type SyncContext } from "./types.js";
import { nonPerson } from "../people/filter.js";
import { hasScopes } from "./tokens.js";
import { getConnector } from "./base.js";

/** Fetch only contact metadata after an explicit sync. No message bodies, artifacts, proposals or model calls. */
export async function syncPeople(id: string, ctx: SyncContext): Promise<number> {
  const provider = getConnector(id)?.account;
  if (!provider || !["gmail", "outlook", "slack", "teams", "github", "google_calendar", "outlook_calendar"].includes(id)) return 0;
  const account = await syncAccount(ctx.userId, provider);
  if (!account) return 0;
  const required: Record<string,string[]> = { gmail: ["https://www.googleapis.com/auth/gmail.readonly"], google_calendar: ["https://www.googleapis.com/auth/calendar.events.readonly"], outlook: ["Mail.Read"], outlook_calendar: ["Calendars.Read"], teams: ["Chat.Read"] };
  if (account.scopes.length && required[id] && !hasScopes(account, required[id])) throw new Error("Reconnect this app with contact access enabled, then sync again.");
  const headers = { Authorization: `Bearer ${account.accessToken}`, Accept: "application/json" };
  const get = async <T>(url: string): Promise<T> => readJson<T>(await fetch(url, { headers, signal: AbortSignal.timeout(15_000) }), "Contact sync");
  const found = new Set<string>();
  const add = async (person: { name?: string | null; email?: string | null; handle?: string | null }, at = new Date(), bulk: Record<string,string> = {}) => {
    if (person.email && nonPerson(person.email, bulk)) return;
    const personId = await upsertPerson(ctx.userId, { ...person, at, evidence: `${id}:contact` }, [account.account, ctx.settings.email]);
    if (personId) found.add(personId);
  };
  if (id === "gmail") {
    const q = `after:${Math.floor(ctx.since.getTime()/1000)} -category:promotions -category:social -category:forums -in:spam -in:trash`;
    const list = await get<{ messages?: Array<{ id: string }> }>(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q, maxResults: "100" })}`);
    for (const row of list.messages ?? []) {
      const params = new URLSearchParams({ format: "metadata" });
      for (const name of ["From", "To", "List-Unsubscribe", "List-Id", "Precedence", "Auto-Submitted"]) params.append("metadataHeaders", name);
      const mail = await get<{ internalDate?: string; labelIds?: string[]; payload?: { headers?: Array<{ name: string; value: string }> } }>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(row.id)}?${params}`);
      const fields = Object.fromEntries((mail.payload?.headers ?? []).map(h => [h.name.toLowerCase(), h.value]));
      const sent = mail.labelIds?.includes("SENT");
      for (const person of parseAddressList(fields[sent ? "to" : "from"])) await add(person, new Date(Number(mail.internalDate) || Date.now()), sent ? {} : fields);
    }
  } else if (id === "outlook") {
    type Contact = { emailAddress?: { name?: string; address?: string } };
    const select = "id,from,toRecipients,receivedDateTime,sentDateTime,internetMessageHeaders,isDraft";
    for (const folder of ["inbox", "sentitems"]) {
      const params = new URLSearchParams({ $top: "100", $select: select, $filter: `${folder === "inbox" ? "receivedDateTime" : "sentDateTime"} ge ${ctx.since.toISOString()}` });
      const page = await get<{ value?: Array<{ from?: Contact; toRecipients?: Contact[]; isDraft?: boolean; receivedDateTime?: string; sentDateTime?: string; internetMessageHeaders?: Array<{ name: string; value: string }> }> }>(`https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?${params}`);
      for (const mail of page.value ?? []) {
        if (mail.isDraft) continue;
        const fields = Object.fromEntries((mail.internetMessageHeaders ?? []).map(h => [h.name.toLowerCase(), h.value]));
        for (const person of folder === "inbox" ? [mail.from] : mail.toRecipients ?? []) if (person?.emailAddress) await add({ name: person.emailAddress.name, email: person.emailAddress.address }, new Date(mail.receivedDateTime ?? mail.sentDateTime ?? Date.now()), folder === "inbox" ? fields : {});
      }
    }
  } else if (id === "slack") {
    const page = await get<{ ok: boolean; members?: Array<{ id: string; name: string; is_bot?: boolean; deleted?: boolean; profile?: { email?: string; real_name?: string } }> }>("https://slack.com/api/users.list?limit=200");
    if (!page.ok) throw new Error("Reconnect Slack to sync people.");
    for (const person of page.members ?? []) if (!person.is_bot && !person.deleted && person.id !== "USLACKBOT") await add({ name: person.profile?.real_name ?? person.name, email: person.profile?.email, handle: `slack:${person.id}` });
  } else if (id === "teams") {
    const chats = await get<{ value?: Array<{ members?: Array<{ displayName?: string; email?: string; userId?: string }> }> }>("https://graph.microsoft.com/v1.0/me/chats?$top=50&$expand=members");
    for (const chat of chats.value ?? []) for (const member of chat.members ?? []) await add({ name: member.displayName, email: member.email, handle: member.userId ? `teams:${member.userId}` : null });
  } else if (id === "github") {
    const people = await get<Array<{ login: string; type: string }>>("https://api.github.com/user/following?per_page=100");
    for (const person of people) if (person.type === "User") await add({ name: person.login, handle: `github:${person.login}` });
  } else {
    type Guest = { email?: string; displayName?: string; emailAddress?: { name?: string; address?: string } };
    const google = id === "google_calendar";
    const url = google ? `https://www.googleapis.com/calendar/v3/calendars/primary/events?${new URLSearchParams({ timeMin: ctx.since.toISOString(), maxResults: "100", singleEvents: "true", fields: "items(attendees(email,displayName))" })}` : `https://graph.microsoft.com/v1.0/me/events?$top=100&$select=attendees`;
    const page = await get<{ items?: Array<{ attendees?: Guest[] }>; value?: Array<{ attendees?: Guest[] }> }>(url);
    for (const event of page.items ?? page.value ?? []) for (const person of event.attendees ?? []) await add({ name: person.displayName ?? person.emailAddress?.name, email: person.email ?? person.emailAddress?.address });
  }
  const synced = await prisma.person.findMany({ where: { userId: ctx.userId, deletedAt: null }, select: { id: true, email: true, upn: true, evidence: true } });
  const filtered = synced.filter(row => row.evidence.some(entry => /^(gmail|outlook|github|slack|teams|google_calendar|outlook_calendar):/.test(entry)) && nonPerson(row.email ?? row.upn ?? ""));
  if (filtered.length) await prisma.person.updateMany({ where: { userId: ctx.userId, id: { in: filtered.map(row => row.id) } }, data: { deletedAt: new Date() } });
  return found.size;
}
