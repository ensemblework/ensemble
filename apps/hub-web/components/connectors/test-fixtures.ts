import { CONNECTOR_CATALOG } from "@ensemble/shared-types";
import type { CatalogEntry, ConnectorState } from "@/lib/api-connectors";

const idle: ConnectorState = { connected: false, account: null, appReady: true, oauthReady: true, products: {}, sources: {} };

/** The real catalog with Mira Chen's connection state layered on top. Test data only. */
export function catalogWith(states: Record<string, Partial<ConnectorState>> = {}): CatalogEntry[] {
  return CONNECTOR_CATALOG.map((entry) => ({ ...entry, state: { ...idle, ...(states[entry.id] ?? {}) } }));
}
