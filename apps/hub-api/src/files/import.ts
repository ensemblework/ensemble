/**
 * Bringing files in from connected apps: which apps this person can use and what
 * to do when one is missing (in plain words), and the import itself. The file is
 * downloaded through the person's own connection and saved like an upload
 * (store.ts), with where it came from. Importing the same item again returns the
 * file Ensemble already keeps. Docs: docs/32_FILES.md.
 */
import type { FileImportSource, FileRecord } from "@ensemble/shared-types";
import type { PrismaClient } from "@prisma/client";
import { oauthApp } from "../connectors/accounts.js";
import { downloadItem, ItemError } from "../connectors/items/index.js";
import { DRIVE_SCOPES, FULL_DRIVE_SCOPES, GMAIL_SCOPES } from "../connectors/items/sources/google.js";
import { hasScopes } from "../connectors/tokens.js";
import { isGuestIn } from "../sharing/context.js";
import { FILE_SELECT, fileRecord, saveFile } from "./store.js";

export const IMPORT_KINDS = ["file", "attachment"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

type Provider = "google" | "microsoft" | "dropbox" | "box";

interface Spec {
  id: string;
  itemSource: string;
  connector: string;
  name: string;
  logo: string;
  kind: ImportKind;
  provider: Provider;
  /** The suite's own name ("Google Workspace") or the app's. */
  connectorName: string;
  /** Any one of these grants is enough; empty means being connected is enough. */
  scopes: readonly string[];
  /** The switch in Settings → Connections that grants it, for suites. */
  product?: string;
}

const SPECS: readonly Spec[] = [
  { id: "google_drive", itemSource: "google_workspace", connector: "google_workspace", name: "Google Drive", logo: "googledrive", kind: "file", provider: "google", connectorName: "Google Workspace", scopes: DRIVE_SCOPES, product: "Drive, Docs, Sheets and Slides" },
  { id: "gmail", itemSource: "google_workspace", connector: "google_workspace", name: "Gmail", logo: "gmail", kind: "attachment", provider: "google", connectorName: "Google Workspace", scopes: GMAIL_SCOPES, product: "Gmail" },
  { id: "onedrive", itemSource: "microsoft_365", connector: "microsoft_365", name: "OneDrive", logo: "onedrive", kind: "file", provider: "microsoft", connectorName: "Microsoft 365", scopes: ["Files.Read"], product: "OneDrive" },
  { id: "outlook", itemSource: "microsoft_365", connector: "microsoft_365", name: "Outlook", logo: "outlook", kind: "attachment", provider: "microsoft", connectorName: "Microsoft 365", scopes: ["Mail.Read"], product: "Outlook mail" },
  { id: "dropbox", itemSource: "dropbox", connector: "dropbox", name: "Dropbox", logo: "dropbox", kind: "file", provider: "dropbox", connectorName: "Dropbox", scopes: ["files.content.read"] },
  { id: "box", itemSource: "box", connector: "box", name: "Box", logo: "box", kind: "file", provider: "box", connectorName: "Box", scopes: [] },
];

const VENDOR: Record<Provider, string> = { google: "Google", microsoft: "Microsoft", dropbox: "Dropbox", box: "Box" };

const settingsHref = (connector: string) => `/settings?tab=connections&connector=${connector}`;
const granted = (scopes: string[], wanted: readonly string[]) => !wanted.length || wanted.some((scope) => hasScopes({ scopes }, [scope]));
const pickerReady = () => Boolean(process.env.GOOGLE_PICKER_API_KEY?.trim() && process.env.GOOGLE_PROJECT_NUMBER?.trim());

/** What the person searches for, in their words. */
function what(spec: Spec): string {
  if (spec.kind === "attachment") return "files attached to your email";
  return spec.id === "box" ? "your files in Box" : `your ${spec.name}`;
}

function describe(spec: Spec, state: FileImportSource["state"], scopes: string[]): Omit<FileImportSource, "id" | "itemSource" | "connector" | "name" | "logo" | "kind" | "state"> {
  const href = settingsHref(spec.connector);
  const vendor = VENDOR[spec.provider];
  const suite = spec.connectorName !== spec.name;
  if (state === "not_set_up") {
    return {
      message: `${spec.name} is not set up on this Ensemble server yet. Whoever runs it registers a ${vendor} app once; after that everyone connects with their own account.`,
      steps: [`Ask whoever runs your Ensemble to set up ${spec.connectorName} in Settings → Connections.`, `Then connect your own ${vendor} account there and come back here.`],
      action: { label: `Open ${spec.connectorName}`, href },
    };
  }
  if (state === "not_connected") {
    return {
      message: suite
        ? `Connect ${spec.connectorName}, keep ${spec.product} switched on, and approve on ${vendor}'s page. Then search ${what(spec)} here.`
        : `Connect ${spec.name} and approve on ${vendor}'s page. Then search ${what(spec)} here.`,
      steps: [
        `Open Settings → Connections and choose ${spec.connectorName}.`,
        ...(suite
          ? [spec.id === "google_drive" ? `Keep “${spec.product}” switched on. Switch on “Search all of Drive” too if you want to find any file.` : `Keep “${spec.product}” switched on.`]
          : []),
        `Press Connect and approve on ${vendor}'s page.`,
        `Come back here and search ${what(spec)}.`,
      ],
      action: { label: `Connect ${spec.connectorName}`, href },
    };
  }
  if (state === "needs_permission") {
    return suite
      ? {
          message: `${spec.connectorName} is connected, but ${spec.product} is switched off.`,
          steps: [`Open Settings → Connections → ${spec.connectorName}.`, `Switch on “${spec.product}”.`, `Approve on ${vendor}'s page, then come back here.`],
          action: { label: `Turn on ${spec.product}`, href },
        }
      : {
          message: `${spec.name} is connected without permission to download files.`,
          steps: [`Open Settings → Connections → ${spec.name}.`, "Disconnect, then connect again.", `Approve everything on ${vendor}'s page, then come back here.`],
          action: { label: `Open ${spec.name}`, href },
        };
  }
  if (spec.id === "google_drive" && !granted(scopes, FULL_DRIVE_SCOPES)) {
    const picker = pickerReady();
    return {
      message: `Ensemble can see only the Drive files it created or that you picked${picker ? ", so pick files from your Drive here" : ""}. To search everything in your Drive, switch on “Search all of Drive”.`,
      steps: [`Open Settings → Connections → ${spec.connectorName}.`, "Switch on “Search all of Drive”.", "Approve on Google's page, then search here."],
      action: { label: "Search all of Drive", href },
      picker,
    };
  }
  return {
    message:
      spec.id === "google_drive"
        ? "Search any file in your Drive. Google Docs, Sheets and Slides come in as Word, Excel and PowerPoint files."
        : spec.kind === "attachment"
          ? `Search ${what(spec)} in ${spec.name}.`
          : `Search ${what(spec)}.`,
    ...(spec.id === "google_drive" && pickerReady() ? { picker: true } : {}),
  };
}

/** The apps files can come from, and for each whether this person can use it yet. Reads only the non-secret token columns. */
export async function importSources(db: PrismaClient, userId: string): Promise<FileImportSource[]> {
  if (isGuestIn(userId)) return [];
  const providers = [...new Set(SPECS.map((spec) => spec.provider))];
  const rows = await db.authToken.findMany({ where: { userId, provider: { in: providers } }, select: { provider: true, scopes: true } });
  const connected = new Map(rows.map((row) => [row.provider, row.scopes]));
  const setUp = new Map(await Promise.all(providers.map(async (provider) => [provider, Boolean(await oauthApp(provider))] as const)));
  return SPECS.map((spec) => {
    const scopes = connected.get(spec.provider);
    // Apps connected before Ensemble recorded their grants have no scopes saved; they were asked for everything.
    const state: FileImportSource["state"] = scopes
      ? !scopes.length && !spec.product
        ? "ready"
        : granted(scopes, spec.scopes)
          ? "ready"
          : "needs_permission"
      : setUp.get(spec.provider)
        ? "not_connected"
        : "not_set_up";
    return { id: spec.id, itemSource: spec.itemSource, connector: spec.connector, name: spec.name, logo: spec.logo, kind: spec.kind, state, ...describe(spec, state, scopes ?? []) };
  });
}

function specFor(ref: { source: string; kind: string }): Spec {
  const spec = SPECS.find((row) => row.itemSource === ref.source && row.kind === ref.kind);
  if (!spec) throw new ItemError(ref.kind === "attachment" ? "Email attachments come from Gmail or Outlook." : "Files come from Google Drive, OneDrive, Dropbox or Box.", 400);
  return spec;
}

export const importExternalId = (ref: { source: string; kind: string; id: string }) => `${ref.source}:${ref.kind}:${ref.id}`.slice(0, 500);

/** Downloads the item and keeps it as a file. `existing` when this item was brought in before and is still kept. */
export async function importFromApp(db: PrismaClient, userId: string, ref: { source: string; kind: ImportKind; id: string }): Promise<{ file: FileRecord; existing: boolean }> {
  const spec = specFor(ref);
  const externalId = importExternalId(ref);
  const kept = await db.document.findFirst({
    where: { userId, deletedAt: null, source: { path: ["externalId"], equals: externalId } },
    orderBy: { createdAt: "desc" },
    select: FILE_SELECT,
  });
  if (kept) return { file: fileRecord(kept), existing: true };
  const download = await downloadItem(userId, ref);
  const file = await saveFile(db, userId, {
    filename: download.filename,
    mediaType: download.mediaType,
    bytes: download.bytes,
    source: { app: spec.id, label: spec.name, ...(download.url ? { url: download.url } : {}), externalId },
  });
  return { file, existing: false };
}
