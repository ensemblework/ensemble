/** Meeting-notes connectors: one entry per vendor with a pasted personal API key. */
import type { SyncContext, SyncResult } from "../types.js";
import { checkFathom, syncFathom } from "./fathom.js";
import { checkFireflies, syncFireflies } from "./fireflies.js";
import { checkGranola, syncGranola } from "./granola.js";
import { checkJamie, syncJamie } from "./jamie.js";
import { checkKrisp, syncKrisp } from "./krisp.js";
import { checkOtter, syncOtter } from "./otter.js";
import { checkTldv, syncTldv } from "./tldv.js";
import { VENDOR_LABEL, type MeetingVendor, type TokenCheck } from "./types.js";

export interface MeetingSource {
  id: MeetingVendor;
  label: string;
  setupHint: string;
  sync: (ctx: SyncContext) => Promise<SyncResult>;
  check: (token: string) => Promise<TokenCheck>;
}

export const MEETING_SOURCES: readonly MeetingSource[] = [
  {
    id: "fireflies",
    label: VENDOR_LABEL.fireflies,
    setupHint: "Paste your Fireflies API key from app.fireflies.ai → Integrations → Fireflies API.",
    sync: syncFireflies,
    check: checkFireflies,
  },
  {
    id: "fathom",
    label: VENDOR_LABEL.fathom,
    setupHint: "Paste a Fathom API key from Fathom → Settings → API Access.",
    sync: syncFathom,
    check: checkFathom,
  },
  {
    id: "granola",
    label: VENDOR_LABEL.granola,
    setupHint: "Paste a Granola API key from the Granola app → Settings → Connectors → API keys (Business plan).",
    sync: syncGranola,
    check: checkGranola,
  },
  {
    id: "tldv",
    label: VENDOR_LABEL.tldv,
    setupHint: "Paste a tl;dv API key from tldv.io → Settings → Personal settings → API keys (Pro or Business plan).",
    sync: syncTldv,
    check: checkTldv,
  },
  {
    id: "krisp",
    label: VENDOR_LABEL.krisp,
    setupHint: "Paste a Krisp API key (krsp_u_…) from Krisp → Integrations → API, with Read access (Core or Advanced plan).",
    sync: syncKrisp,
    check: checkKrisp,
  },
  {
    id: "jamie",
    label: VENDOR_LABEL.jamie,
    setupHint: "Paste a personal Jamie API key (jk_…) from Jamie → Settings → Developers → API Keys (Pro, Team or Enterprise plan).",
    sync: syncJamie,
    check: checkJamie,
  },
  {
    id: "otter",
    label: VENDOR_LABEL.otter,
    setupHint: "Paste an Otter API key from Otter → Integrations → Developer. Otter's API is for Enterprise workspaces only.",
    sync: syncOtter,
    check: checkOtter,
  },
];

export function meetingSource(id: string): MeetingSource | undefined {
  return MEETING_SOURCES.find((source) => source.id === id);
}
