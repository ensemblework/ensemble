/**
 * Xero: invoices and bills (by contact name or number, or the newest) and contacts in
 * the organisation picked at connect; an invoice with its lines and totals, a contact
 * with balances and recent invoices. Ids: Xero's InvoiceID or ContactID.
 */
import type { AppItem, AppItemContent } from "@ensemble/shared-types";
import { facts, itemFetch, itemMarkdown } from "../http.js";
import { ItemError, type ItemContext, type ItemSource } from "../types.js";

const API = "https://api.xero.com/api.xro/2.0";
const LABEL = "Xero";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LineItem {
  Description?: string;
  Quantity?: number;
  UnitAmount?: number;
  LineAmount?: number;
}

interface Invoice {
  InvoiceID: string;
  InvoiceNumber?: string;
  Type?: string;
  Status?: string;
  Reference?: string;
  Contact?: { ContactID?: string; Name?: string };
  DateString?: string;
  DueDateString?: string;
  CurrencyCode?: string;
  SubTotal?: number;
  TotalTax?: number;
  Total?: number;
  AmountDue?: number;
  AmountPaid?: number;
  UpdatedDateUTC?: string;
  LineItems?: LineItem[];
}

interface Contact {
  ContactID: string;
  Name: string;
  EmailAddress?: string;
  ContactStatus?: string;
  IsCustomer?: boolean;
  IsSupplier?: boolean;
  UpdatedDateUTC?: string;
  Phones?: Array<{ PhoneType?: string; PhoneNumber?: string; PhoneAreaCode?: string; PhoneCountryCode?: string }>;
  Balances?: {
    AccountsReceivable?: { Outstanding?: number; Overdue?: number };
    AccountsPayable?: { Outstanding?: number; Overdue?: number };
  };
}

function tenant(ctx: ItemContext): string {
  const id = ctx.token.meta?.tenantId;
  if (typeof id !== "string" || !GUID.test(id)) throw new ItemError("Xero is connected without an organisation. Connect it again and pick one.", 409);
  return id;
}

const get = <T>(ctx: ItemContext, path: string) =>
  itemFetch<T>(ctx, "xero", LABEL, `${API}${path}`, { headers: { Authorization: `Bearer ${ctx.token.token}`, "xero-tenant-id": tenant(ctx) } });

/** Xero's "/Date(1696204800000+0000)/" (or an ISO string) → ISO. */
export function xeroDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = /\/Date\((-?\d+)(?:[+-]\d{4})?\)\//.exec(value);
  const date = ms ? new Date(Number(ms[1])) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

const money = (amount: number | undefined, currency: string | undefined) => (typeof amount === "number" ? `${amount.toFixed(2)}${currency ? ` ${currency}` : ""}` : null);

const isBill = (invoice: Invoice) => invoice.Type === "ACCPAY";

const invoiceUrl = (invoice: Invoice) => `https://go.xero.com/${isBill(invoice) ? "AccountsPayable" : "AccountsReceivable"}/View.aspx?InvoiceID=${invoice.InvoiceID}`;

function invoiceItem(invoice: Invoice): AppItem {
  const what = isBill(invoice) ? "Bill" : "Invoice";
  return {
    source: "xero",
    kind: "invoice",
    id: invoice.InvoiceID,
    title: `${invoice.InvoiceNumber || what} · ${invoice.Contact?.Name ?? "No contact"}`,
    subtitle: [what, invoice.Status?.toLowerCase(), money(invoice.Total, invoice.CurrencyCode), invoice.DueDateString ? `due ${invoice.DueDateString.slice(0, 10)}` : null].filter(Boolean).join(" · "),
    url: invoiceUrl(invoice),
    updatedAt: xeroDate(invoice.UpdatedDateUTC),
  };
}

function contactItem(contact: Contact): AppItem {
  return {
    source: "xero",
    kind: "contact",
    id: contact.ContactID,
    title: contact.Name,
    subtitle: [contact.EmailAddress, contact.IsCustomer ? "customer" : null, contact.IsSupplier ? "supplier" : null, contact.ContactStatus && contact.ContactStatus !== "ACTIVE" ? contact.ContactStatus.toLowerCase() : null]
      .filter(Boolean)
      .join(" · "),
    url: `https://go.xero.com/Contacts/View/${contact.ContactID}`,
    updatedAt: xeroDate(contact.UpdatedDateUTC),
  };
}

/** A filter string for Xero's `where`; quotes and backslashes would end the string early. */
const filterText = (q: string) => q.replace(/["\\]/g, "").slice(0, 100);

const NEWEST_INVOICES = `order=${encodeURIComponent("Date DESC")}&page=1&summaryOnly=true`;

const cell = (value: string | number | undefined) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export const xeroItems: ItemSource = {
  id: "xero",
  provider: "xero",
  label: LABEL,
  kinds: ["invoice", "contact"],
  async search(ctx, query) {
    const q = filterText(query.q.trim());
    const out: AppItem[] = [];
    if (!query.kind || query.kind === "invoice") {
      const where = q ? `&where=${encodeURIComponent(`Contact.Name.Contains("${q}") OR (InvoiceNumber != null AND InvoiceNumber.Contains("${q}"))`)}` : "";
      const found = await get<{ Invoices: Invoice[] }>(ctx, `/Invoices?${NEWEST_INVOICES}${where}`);
      out.push(...found.Invoices.slice(0, query.limit).map(invoiceItem));
    }
    if (!query.kind || query.kind === "contact") {
      const filter = q ? `searchTerm=${encodeURIComponent(q)}` : `order=${encodeURIComponent("UpdatedDateUTC DESC")}`;
      const found = await get<{ Contacts: Contact[] }>(ctx, `/Contacts?${filter}&page=1&summaryOnly=true`);
      out.push(...found.Contacts.slice(0, query.kind ? query.limit : 5).map(contactItem));
    }
    return out;
  },
  async read(ctx, ref): Promise<AppItemContent> {
    if (!GUID.test(ref.id)) throw new ItemError("That is not a Xero id.", 400);
    if (ref.kind === "contact") {
      const { Contacts } = await get<{ Contacts: Contact[] }>(ctx, `/Contacts/${ref.id}`);
      const contact = Contacts[0];
      if (!contact) throw new ItemError("Xero could not find that contact.", 404);
      const { Invoices } = await get<{ Invoices: Invoice[] }>(ctx, `/Invoices?ContactIDs=${ref.id}&${NEWEST_INVOICES}`);
      const phone = contact.Phones?.find((row) => row.PhoneNumber);
      const receivable = contact.Balances?.AccountsReceivable;
      const payable = contact.Balances?.AccountsPayable;
      const list = facts({
        Email: contact.EmailAddress,
        Phone: phone ? [phone.PhoneCountryCode, phone.PhoneAreaCode, phone.PhoneNumber].filter(Boolean).join(" ") : null,
        Role: [contact.IsCustomer ? "customer" : null, contact.IsSupplier ? "supplier" : null].filter(Boolean).join(", "),
        "Owes you": receivable?.Outstanding ? money(receivable.Outstanding, undefined) : null,
        "Overdue to you": receivable?.Overdue ? money(receivable.Overdue, undefined) : null,
        "You owe": payable?.Outstanding ? money(payable.Outstanding, undefined) : null,
        Status: contact.ContactStatus,
      });
      const lines = Invoices.slice(0, 10).map((invoice) => {
        const item = invoiceItem(invoice);
        return `- ${invoice.InvoiceNumber || (isBill(invoice) ? "Bill" : "Invoice")} (${invoice.DateString?.slice(0, 10) ?? "no date"}): ${item.subtitle}`;
      });
      return {
        ...contactItem(contact),
        facts: list,
        people: contact.EmailAddress ? [{ name: contact.Name, email: contact.EmailAddress }] : [],
        text: itemMarkdown(contact.Name, list, lines.length ? `## Recent invoices and bills\n\n${lines.join("\n")}` : ""),
      };
    }
    const { Invoices } = await get<{ Invoices: Invoice[] }>(ctx, `/Invoices/${ref.id}`);
    const invoice = Invoices[0];
    if (!invoice) throw new ItemError("Xero could not find that invoice.", 404);
    const currency = invoice.CurrencyCode;
    const list = facts({
      Type: isBill(invoice) ? "Bill" : "Invoice",
      Status: invoice.Status,
      Contact: invoice.Contact?.Name,
      Date: invoice.DateString?.slice(0, 10),
      Due: invoice.DueDateString?.slice(0, 10),
      Total: money(invoice.Total, currency),
      "Amount due": money(invoice.AmountDue, currency),
      "Amount paid": invoice.AmountPaid ? money(invoice.AmountPaid, currency) : null,
      Reference: invoice.Reference,
    });
    const rows = (invoice.LineItems ?? []).map((line) => `| ${cell(line.Description)} | ${cell(line.Quantity)} | ${cell(line.UnitAmount?.toFixed(2))} | ${cell(line.LineAmount?.toFixed(2))} |`);
    const table = rows.length ? ["| Description | Quantity | Unit price | Amount |", "| --- | ---: | ---: | ---: |", ...rows].join("\n") : "";
    const totals = [`Subtotal: ${money(invoice.SubTotal, currency) ?? "-"}`, `Tax: ${money(invoice.TotalTax, currency) ?? "-"}`, `Total: ${money(invoice.Total, currency) ?? "-"}`].join("\n");
    const item = invoiceItem(invoice);
    return { ...item, facts: list, text: itemMarkdown(item.title, list, [table, totals].filter(Boolean).join("\n\n")) };
  },
};
