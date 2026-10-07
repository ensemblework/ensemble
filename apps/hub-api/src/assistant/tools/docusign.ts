/**
 * Docusign (read only): envelopes and who still has to act on them, through
 * the eSignature REST API v2.1 on the account's own base URI.
 */
import { z } from "zod";
import { zonedDateTimeToUtc, zonedParts } from "../../lib/clock.js";
import { defineTool, toolOk, type AppToolMeta } from "../types.js";
import { addDays, appAccess, appFetch, localStamp, plural, quote } from "./apps-common.js";
import { ConnectorNotConnectedError, type ProviderToken } from "../../connectors/tokens.js";

const DOCUSIGN: AppToolMeta = { provider: "docusign", suite: "docusign", products: [], scopes: [["signature"]], label: "Docusign" };

/** The account's API root. The base URI comes from Docusign at connect time and must stay on Docusign. */
export function docusignRoot(token: Pick<ProviderToken, "extra">): { root: string; app: string } {
  const accountId = token.extra?.accountId;
  const baseUri = token.extra?.baseUri;
  if (!accountId || !baseUri) throw new ConnectorNotConnectedError("docusign", "This Docusign connection has no account saved. Connect Docusign again in Settings → Connections.");
  let url: URL;
  try {
    url = new URL(baseUri);
  } catch {
    throw new ConnectorNotConnectedError("docusign", "This Docusign connection has a broken account address. Connect Docusign again in Settings → Connections.");
  }
  if (url.protocol !== "https:" || !/(^|\.)docusign\.(net|com)$/.test(url.hostname)) {
    throw new ConnectorNotConnectedError("docusign", "This Docusign connection points outside Docusign, so Ensemble did not use it. Connect Docusign again in Settings → Connections.");
  }
  const demo = token.extra?.env === "demo" || /demo/.test(url.hostname);
  return {
    root: `${url.origin}/restapi/v2.1/accounts/${encodeURIComponent(accountId)}`,
    app: demo ? "https://appdemo.docusign.com" : "https://app.docusign.com",
  };
}

const STATUS: Record<string, string> = {
  any: "any",
  waiting: "sent,delivered",
  completed: "completed",
  declined: "declined",
  voided: "voided",
  draft: "created",
};

interface Recipient {
  name?: string;
  email?: string;
  status?: string;
  routingOrder?: string;
  signedDateTime?: string;
  deliveredDateTime?: string;
  declinedReason?: string;
}

interface Recipients {
  signers?: Recipient[];
  carbonCopies?: Recipient[];
  certifiedDeliveries?: Recipient[];
  inPersonSigners?: Recipient[];
  editors?: Recipient[];
  agents?: Recipient[];
  intermediaries?: Recipient[];
  witnesses?: Recipient[];
}

interface Envelope {
  envelopeId: string;
  status?: string;
  emailSubject?: string;
  sentDateTime?: string;
  completedDateTime?: string;
  declinedDateTime?: string;
  voidedReason?: string;
  expireDateTime?: string;
  lastModifiedDateTime?: string;
  statusChangedDateTime?: string;
  sender?: { userName?: string; email?: string };
  recipients?: Recipients;
}

const ROLES: Array<[keyof Recipients, string]> = [
  ["signers", "signer"],
  ["inPersonSigners", "in-person signer"],
  ["witnesses", "witness"],
  ["editors", "editor"],
  ["agents", "agent"],
  ["intermediaries", "intermediary"],
  ["certifiedDeliveries", "needs to view"],
  ["carbonCopies", "gets a copy"],
];

/** Everyone on the envelope, in signing order, and the ones it is waiting on now (sent or opened, not done). */
export function envelopePeople(recipients: Recipients | undefined, timeZone: string) {
  const people = ROLES.flatMap(([key, role]) =>
    (recipients?.[key] ?? []).map((row) => ({
      name: row.name ?? row.email ?? "?",
      email: row.email,
      role,
      order: Number(row.routingOrder ?? 1) || 1,
      status: row.status ?? "created",
      ...(row.signedDateTime ? { signed: localStamp(row.signedDateTime, timeZone) } : {}),
      ...(row.declinedReason ? { declinedReason: row.declinedReason } : {}),
    })),
  ).sort((a, b) => a.order - b.order);
  const waitingOn = people.filter((person) => person.status === "sent" || person.status === "delivered");
  return { people, waitingOn };
}

const who = (people: Array<{ name: string; email?: string }>) => people.map((person) => (person.email && person.email !== person.name ? `${person.name} <${person.email}>` : person.name));

export const docusignListEnvelopes = defineTool({
  name: "docusign_list_envelopes",
  area: "apps",
  app: DOCUSIGN,
  description: "List Docusign envelopes changed since a date, by status, with who each one is waiting on.",
  input: z.object({
    status: z.enum(["any", "waiting", "completed", "declined", "voided", "draft"]).default("any").describe("waiting = sent and not finished."),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD; defaults to 30 days ago."),
    needsMySignature: z.boolean().default(false).describe("Only envelopes waiting for the person's own signature."),
    query: z.string().max(100).optional().describe("Words in the subject, sender or recipients."),
    max: z.number().int().min(1).max(50).default(20),
  }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const zone = ctx.settings.timezone;
    const from = input.from ?? addDays(zonedParts(zone).date, -30);
    const access = await appAccess(ctx, DOCUSIGN);
    const { root, app } = docusignRoot(access);
    const params = new URLSearchParams({
      from_date: zonedDateTimeToUtc(from, "00:00", zone).toISOString(),
      status: STATUS[input.status]!,
      count: String(input.max),
      order_by: "last_modified",
      order: "desc",
      include: "recipients",
    });
    if (input.needsMySignature) params.set("folder_types", "awaiting_my_signatures");
    if (input.query?.trim()) params.set("search_text", input.query.trim());
    const body = await appFetch<{ envelopes?: Envelope[]; totalSetSize?: string }>(ctx, DOCUSIGN, access.token, `${root}/envelopes?${params}`);
    const envelopes = (body.envelopes ?? []).map((envelope) => {
      const { waitingOn } = envelopePeople(envelope.recipients, zone);
      return {
        id: envelope.envelopeId,
        subject: envelope.emailSubject ?? "(no subject)",
        status: envelope.status,
        sent: localStamp(envelope.sentDateTime, zone) || undefined,
        changed: localStamp(envelope.statusChangedDateTime ?? envelope.lastModifiedDateTime, zone) || undefined,
        sender: envelope.sender?.userName ?? envelope.sender?.email,
        waitingOn: who(waitingOn),
        link: `${app}/documents/details/${encodeURIComponent(envelope.envelopeId)}`,
      };
    });
    return toolOk(`Found ${plural(envelopes.length, "Docusign envelope")} changed since ${from}.`, { from, envelopes });
  },
});

export const docusignGetEnvelope = defineTool({
  name: "docusign_get_envelope",
  area: "apps",
  app: DOCUSIGN,
  description: "Read one Docusign envelope: its status, every recipient in signing order, and who it is waiting on.",
  input: z.object({ envelopeId: z.string().trim().regex(/^[0-9a-fA-F-]{8,64}$/, "A Docusign envelope id looks like 1b2c3d4e-...") }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const zone = ctx.settings.timezone;
    const access = await appAccess(ctx, DOCUSIGN);
    const { root, app } = docusignRoot(access);
    const envelope = await appFetch<Envelope>(ctx, DOCUSIGN, access.token, `${root}/envelopes/${encodeURIComponent(input.envelopeId)}?include=recipients`);
    const { people, waitingOn } = envelopePeople(envelope.recipients, zone);
    const link = `${app}/documents/details/${encodeURIComponent(envelope.envelopeId ?? input.envelopeId)}`;
    const subject = envelope.emailSubject ?? "(no subject)";
    const waiting = who(waitingOn);
    return toolOk(
      `${quote(subject)} is ${envelope.status ?? "unknown"}${waiting.length ? `, waiting on ${waiting.join(", ")}` : ""}.`,
      {
        id: envelope.envelopeId,
        subject,
        status: envelope.status,
        sender: envelope.sender?.userName ?? envelope.sender?.email,
        sent: localStamp(envelope.sentDateTime, zone) || undefined,
        completed: localStamp(envelope.completedDateTime, zone) || undefined,
        declined: localStamp(envelope.declinedDateTime, zone) || undefined,
        expires: localStamp(envelope.expireDateTime, zone) || undefined,
        voidedReason: envelope.voidedReason,
        recipients: people,
        waitingOn: waiting,
        link,
      },
      { href: link },
    );
  },
});

export const docusignTools = [docusignListEnvelopes, docusignGetEnvelope];
