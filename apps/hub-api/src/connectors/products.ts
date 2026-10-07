/**
 * Products inside the Google Workspace and Microsoft 365 connectors, and the
 * OAuth scopes each one needs. Connect asks only for the base scopes plus the
 * scopes of the products that are switched on (settings.connectorProducts).
 */
import { catalogEntry, type ConnectorId, type Settings } from "@ensemble/shared-types";
import type { AccountProvider } from "./accounts.js";

export interface ProductSpec {
  scopes: readonly string[];
  /** Sync sources this product feeds (settings.connections keys). */
  sources: readonly ConnectorId[];
  defaultOn: boolean;
}

export interface SuiteSpec {
  /** Connector store id, e.g. google_workspace. */
  id: string;
  provider: AccountProvider;
  base: readonly string[];
  products: Readonly<Record<string, ProductSpec>>;
}

const GOOGLE = "https://www.googleapis.com/auth/";

export const GOOGLE_PRODUCT_SCOPES = {
  gmail: [`${GOOGLE}gmail.readonly`],
  calendar: [`${GOOGLE}calendar.events`, `${GOOGLE}calendar.calendarlist.readonly`],
  drive_docs: [`${GOOGLE}drive.file`],
  drive_search: [`${GOOGLE}drive.readonly`],
} as const;

export const SUITES: Readonly<Record<string, SuiteSpec>> = {
  google_workspace: {
    id: "google_workspace",
    provider: "google",
    base: ["openid", "email", "profile"],
    products: {
      gmail: { scopes: GOOGLE_PRODUCT_SCOPES.gmail, sources: ["gmail"], defaultOn: true },
      calendar: { scopes: GOOGLE_PRODUCT_SCOPES.calendar, sources: ["google_calendar"], defaultOn: true },
      drive_docs: { scopes: GOOGLE_PRODUCT_SCOPES.drive_docs, sources: [], defaultOn: true },
      // Restricted scope: public servers need Google's security assessment before this can be offered to everyone.
      drive_search: { scopes: GOOGLE_PRODUCT_SCOPES.drive_search, sources: [], defaultOn: false },
    },
  },
  microsoft_365: {
    id: "microsoft_365",
    provider: "microsoft",
    base: ["openid", "email", "profile", "offline_access", "User.Read"],
    products: {
      outlook_mail: { scopes: ["Mail.Read"], sources: ["outlook"], defaultOn: true },
      outlook_calendar: { scopes: ["Calendars.ReadWrite"], sources: ["outlook_calendar"], defaultOn: true },
      // Work or school accounts only; personal Microsoft accounts have no Teams chats in Graph.
      teams: { scopes: ["Chat.Read"], sources: ["teams"], defaultOn: false },
      onedrive: { scopes: ["Files.Read"], sources: [], defaultOn: true },
      office: { scopes: ["Files.ReadWrite"], sources: [], defaultOn: true },
    },
  },
};

export function suiteById(id: string): SuiteSpec | undefined {
  return SUITES[id];
}

export function suiteForProvider(provider: string): SuiteSpec | undefined {
  return Object.values(SUITES).find((suite) => suite.provider === provider);
}

/** Product defaults from the connector catalog, so Connect and the store agree. */
export function catalogProductDefaults(catalogId: string): Record<string, boolean> {
  return Object.fromEntries((catalogEntry(catalogId)?.products ?? []).map((product) => [product.id, product.defaultOn]));
}

/** Saved toggles over the catalog defaults, then the built-in defaults. */
export function productState(suite: SuiteSpec, settings: Pick<Settings, "connectorProducts">): Record<string, boolean> {
  const saved = settings.connectorProducts?.[suite.id] ?? {};
  const catalogDefaults = catalogProductDefaults(suite.id);
  return Object.fromEntries(
    Object.entries(suite.products).map(([id, spec]) => [id, saved[id] ?? catalogDefaults[id] ?? spec.defaultOn]),
  );
}

export function scopesFor(suite: SuiteSpec, products: Record<string, boolean>): string[] {
  const scopes = new Set<string>(suite.base);
  for (const [id, on] of Object.entries(products)) {
    if (on) for (const scope of suite.products[id]?.scopes ?? []) scopes.add(scope);
  }
  return [...scopes];
}

/** Sync sources switched on by the products that are on, and off by the ones that are off. */
export function sourceToggles(suite: SuiteSpec, products: Record<string, boolean>): Partial<Record<ConnectorId, boolean>> {
  const out: Partial<Record<ConnectorId, boolean>> = {};
  for (const [id, spec] of Object.entries(suite.products)) {
    for (const source of spec.sources) out[source] = Boolean(products[id]) || Boolean(out[source]);
  }
  return out;
}
