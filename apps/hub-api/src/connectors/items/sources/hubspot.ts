/**
 * HubSpot: contacts, companies, deals and tickets (CRM search), a record with its main
 * properties, owner and associations, the account's owners, and notes on records.
 * Ids: HubSpot's record id. A record link gives "<portal id>/<record id>" so a note
 * never lands on another account's record with the same id.
 */
import type { AppItem, AppItemContent, AppItemKind, AppItemPerson } from "@ensemble/shared-types";
import { escapeHtml } from "../../../lib/office/html.js";
import { htmlToText } from "../../../lib/office/text.js";
import { facts, itemFetch, itemMarkdown, type ItemRequest } from "../http.js";
import { ItemError, type ItemContext, type ItemSource } from "../types.js";

const API = "https://api.hubapi.com";
const LABEL = "HubSpot";
const RECORD = /^\d{1,20}$/;
const MAX_OWNER_PAGES = 5;

type CrmKind = "contact" | "company" | "deal" | "ticket";

interface CrmObject {
  /** Path segment under /crm/v3/objects. */
  path: string;
  /** Object type id used in record links. */
  typeId: string;
  /** HubSpot-defined association type from a note to this object. */
  noteAssociation: number;
  modified: string;
  properties: readonly string[];
}

const OBJECTS: Record<CrmKind, CrmObject> = {
  contact: {
    path: "contacts",
    typeId: "0-1",
    noteAssociation: 202,
    modified: "lastmodifieddate",
    properties: ["firstname", "lastname", "email", "jobtitle", "company", "phone", "lifecyclestage", "hubspot_owner_id", "lastmodifieddate"],
  },
  company: {
    path: "companies",
    typeId: "0-2",
    noteAssociation: 190,
    modified: "hs_lastmodifieddate",
    properties: ["name", "domain", "industry", "city", "country", "numberofemployees", "lifecyclestage", "hubspot_owner_id", "description", "hs_lastmodifieddate"],
  },
  deal: {
    path: "deals",
    typeId: "0-3",
    noteAssociation: 214,
    modified: "hs_lastmodifieddate",
    properties: ["dealname", "amount", "deal_currency_code", "dealstage", "pipeline", "closedate", "hubspot_owner_id", "description", "hs_lastmodifieddate"],
  },
  ticket: {
    path: "tickets",
    typeId: "0-5",
    noteAssociation: 228,
    modified: "hs_lastmodifieddate",
    properties: ["subject", "content", "hs_pipeline", "hs_pipeline_stage", "hs_ticket_priority", "hubspot_owner_id", "createdate", "hs_lastmodifieddate"],
  },
};

const PROPERTY_LABEL: Record<string, string> = {
  firstname: "First name",
  lastname: "Last name",
  email: "Email",
  jobtitle: "Job title",
  company: "Company",
  phone: "Phone",
  lifecyclestage: "Lifecycle stage",
  name: "Name",
  domain: "Domain",
  industry: "Industry",
  city: "City",
  country: "Country",
  numberofemployees: "Employees",
  dealname: "Deal",
  amount: "Amount",
  deal_currency_code: "Currency",
  dealstage: "Stage",
  pipeline: "Pipeline",
  closedate: "Close date",
  subject: "Subject",
  hs_pipeline: "Pipeline",
  hs_pipeline_stage: "Stage",
  hs_ticket_priority: "Priority",
  createdate: "Created",
};

/** Search order, most useful first. */
const KINDS: readonly CrmKind[] = ["deal", "contact", "company", "ticket"];
const KIND_BY_TYPE = new Map(KINDS.map((kind) => [OBJECTS[kind].typeId, kind]));

interface CrmRecord {
  id: string;
  properties: Record<string, string | null | undefined>;
  updatedAt?: string;
  associations?: Record<string, { results?: Array<{ id: string }> }>;
}

const isCrmKind = (kind: AppItemKind): kind is CrmKind => kind in OBJECTS;

function call<T>(ctx: ItemContext, path: string, init: ItemRequest = {}): Promise<T> {
  return itemFetch<T>(ctx, "hubspot", LABEL, `${API}${path}`, { ...init, headers: { Authorization: `Bearer ${ctx.token.token}`, ...init.headers } });
}

function portal(ctx: ItemContext): { id: string | null; ui: string } {
  const id = ctx.token.meta?.portalId;
  const ui = ctx.token.meta?.uiDomain;
  return {
    id: (typeof id === "number" || typeof id === "string") && RECORD.test(String(id)) ? String(id) : null,
    ui: typeof ui === "string" && /^app(-[a-z0-9]+)?\.hubspot\.com$/.test(ui) ? ui : "app.hubspot.com",
  };
}

function recordUrl(ctx: ItemContext, kind: CrmKind, id: string): string | undefined {
  const { id: portalId, ui } = portal(ctx);
  return portalId ? `https://${ui}/contacts/${portalId}/record/${OBJECTS[kind].typeId}/${id}` : undefined;
}

function describe(kind: CrmKind, p: CrmRecord["properties"], id: string): { title: string; subtitle: string } {
  const join = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join(" · ");
  switch (kind) {
    case "contact":
      return { title: [p.firstname, p.lastname].filter(Boolean).join(" ") || p.email || `Contact ${id}`, subtitle: join("Contact", p.email, p.jobtitle, p.company) };
    case "company":
      return { title: p.name || p.domain || `Company ${id}`, subtitle: join("Company", p.domain, p.industry, p.city) };
    case "deal":
      return { title: p.dealname || `Deal ${id}`, subtitle: join("Deal", p.dealstage, p.amount ? `${p.amount}${p.deal_currency_code ? ` ${p.deal_currency_code}` : ""}` : null, p.closedate?.slice(0, 10)) };
    case "ticket":
      return { title: p.subject || `Ticket ${id}`, subtitle: join("Ticket", p.hs_pipeline_stage ? `stage ${p.hs_pipeline_stage}` : null, p.hs_ticket_priority?.toLowerCase()) };
  }
}

function recordItem(ctx: ItemContext, kind: CrmKind, record: CrmRecord): AppItem {
  return { source: "hubspot", kind, id: record.id, ...describe(kind, record.properties, record.id), url: recordUrl(ctx, kind, record.id), updatedAt: record.updatedAt ?? record.properties[OBJECTS[kind].modified] ?? undefined };
}

/** A record link (…/contacts/<portal>/record/0-5/<id>) → its kind and "<portal>/<id>". */
export function hubspotRecordRef(text: string): { kind: CrmKind; id: string } | null {
  const match = /hubspot\.com\/contacts\/(\d{1,20})\/record\/(0-\d{1,2})\/(\d{1,20})/i.exec(text.trim());
  const kind = match ? KIND_BY_TYPE.get(match[2]!) : undefined;
  return match && kind ? { kind, id: `${match[1]}/${match[3]}` } : null;
}

/** "123", or "<portal>/123" when that portal is the connected account. */
function recordId(ctx: ItemContext, id: string): string {
  const [first = "", second, extra] = id.trim().split("/");
  if (extra !== undefined) throw new ItemError("That is not a HubSpot record id.", 400);
  if (second !== undefined) {
    const own = portal(ctx).id;
    if (own && first !== own) throw new ItemError(`That record is in HubSpot account ${first}, but HubSpot is connected to account ${own}.`, 409);
  }
  const value = second ?? first;
  if (!RECORD.test(value)) throw new ItemError("That is not a HubSpot record id.", 400);
  return value;
}

async function searchKind(ctx: ItemContext, kind: CrmKind, q: string, limit: number): Promise<AppItem[]> {
  const spec = OBJECTS[kind];
  const found = await call<{ results: CrmRecord[] }>(ctx, `/crm/v3/objects/${spec.path}/search`, {
    method: "POST",
    body: { ...(q ? { query: q } : {}), limit, properties: spec.properties, sorts: [{ propertyName: spec.modified, direction: "DESCENDING" }] },
  });
  return found.results.map((record) => recordItem(ctx, kind, record));
}

export const hubspotItems: ItemSource = {
  id: "hubspot",
  provider: "hubspot",
  label: LABEL,
  kinds: KINDS,
  async search(ctx, query) {
    const q = query.q.trim().slice(0, 200);
    const link = hubspotRecordRef(q);
    if (link) {
      if (query.kind && query.kind !== link.kind) return [];
      const read = await this.read(ctx, link);
      return [{ source: read.source, kind: read.kind, id: read.id, title: read.title, subtitle: read.subtitle, url: read.url, updatedAt: read.updatedAt }];
    }
    if (query.kind) {
      if (!isCrmKind(query.kind)) return [];
      return searchKind(ctx, query.kind, q, query.limit);
    }
    const out: AppItem[] = [];
    const failures: unknown[] = [];
    // One kind at a time: HubSpot allows a few search calls per second per account.
    for (const kind of KINDS) {
      try {
        out.push(...(await searchKind(ctx, kind, q, Math.min(5, query.limit))));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === KINDS.length) throw failures[0];
    return out;
  },
  async read(ctx, ref): Promise<AppItemContent> {
    if (!isCrmKind(ref.kind)) throw new ItemError(`HubSpot has no ${ref.kind.replace("_", " ")} records here.`, 400);
    const kind = ref.kind;
    const spec = OBJECTS[kind];
    const id = recordId(ctx, ref.id);
    const base = `/crm/v3/objects/${spec.path}/${id}?properties=${spec.properties.join(",")}`;
    const others = KINDS.filter((other) => other !== kind).map((other) => OBJECTS[other].path);
    // Associations need read access to the other objects too; without it, read the record alone.
    const record = await call<CrmRecord>(ctx, `${base}&associations=${others.join(",")}`).catch((error: unknown) => {
      if (error instanceof ItemError && error.statusCode === 403) return call<CrmRecord>(ctx, base);
      throw error;
    });
    const p = record.properties;
    const owner = p.hubspot_owner_id && RECORD.test(p.hubspot_owner_id)
      ? await call<{ firstName?: string; lastName?: string; email?: string }>(ctx, `/crm/v3/owners/${p.hubspot_owner_id}`).catch(() => null)
      : null;
    const ownerName = owner ? [owner.firstName, owner.lastName].filter(Boolean).join(" ") || owner.email : null;
    const associated = Object.entries(record.associations ?? {})
      .map(([type, value]) => [type, value.results?.length ?? 0] as const)
      .filter(([, count]) => count > 0)
      .map(([type, count]) => `${count} ${type}`)
      .join(", ");
    const shown = spec.properties.filter((name) => PROPERTY_LABEL[name]);
    const list = facts({
      ...Object.fromEntries(shown.map((name) => [PROPERTY_LABEL[name]!, name.endsWith("date") ? (p[name]?.slice(0, 10) ?? null) : (p[name] ?? null)])),
      Owner: ownerName,
      Associated: associated,
    });
    const body = p.content ?? p.description ?? "";
    const people: AppItemPerson[] = [];
    if (kind === "contact" && (p.firstname || p.lastname || p.email)) {
      people.push({ name: [p.firstname, p.lastname].filter(Boolean).join(" ") || p.email!, ...(p.email ? { email: p.email } : {}), ...(p.jobtitle ? { title: p.jobtitle } : {}) });
    }
    if (ownerName) people.push({ name: ownerName, ...(owner?.email ? { email: owner.email } : {}) });
    const item = recordItem(ctx, kind, record);
    return { ...item, facts: list, people, text: itemMarkdown(item.title, list, /<[a-z][^>]*>/i.test(body) ? htmlToText(body) : body) };
  },
  async people(ctx) {
    const out: AppItemPerson[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_OWNER_PAGES; page += 1) {
      const found = await call<{ results: Array<{ email?: string; firstName?: string; lastName?: string; archived?: boolean }>; paging?: { next?: { after?: string } } }>(
        ctx,
        `/crm/v3/owners?limit=100&archived=false${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      );
      for (const owner of found.results) {
        const name = [owner.firstName, owner.lastName].filter(Boolean).join(" ") || owner.email;
        if (name && !owner.archived) out.push({ name, ...(owner.email ? { email: owner.email } : {}) });
      }
      after = found.paging?.next?.after;
      if (!after) break;
    }
    return out;
  },
  fromUrl(url) {
    return hubspotRecordRef(url);
  },
  async comment(ctx, ref, body) {
    if (!isCrmKind(ref.kind)) throw new ItemError("Only HubSpot contacts, companies, deals and tickets take notes.", 400);
    const id = recordId(ctx, ref.id);
    await call(ctx, "/crm/v3/objects/notes", {
      method: "POST",
      body: {
        properties: { hs_note_body: escapeHtml(body).replace(/\n/g, "<br>"), hs_timestamp: new Date().toISOString() },
        associations: [{ to: { id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: OBJECTS[ref.kind].noteAssociation }] }],
      },
    });
    return { url: recordUrl(ctx, ref.kind, id) };
  },
};
