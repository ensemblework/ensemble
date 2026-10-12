/**
 * App items: search, read and list people in a person's connected apps, through
 * the account they connected (connectors/tokens.ts). One file per app in ./sources.
 */
import type { AppItem, AppItemContent, AppItemKind, AppItemPerson } from "@ensemble/shared-types";
import type { AccountProvider } from "../accounts.js";
import type { ProviderToken } from "../tokens.js";

export type { AppItem, AppItemContent, AppItemKind, AppItemPerson };

/** Text kept from one read, for the assistant, agents and search. */
export const MAX_ITEM_TEXT = 20_000;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 25;
export const MAX_PEOPLE = 500;
/** Largest file brought in from an app. */
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export interface ItemContext {
  userId: string;
  token: ProviderToken;
  /** Tests replace fetch; production uses the global one. */
  fetch: typeof fetch;
  signal: AbortSignal;
}

export interface ItemSearch {
  q: string;
  kind?: AppItemKind;
  limit: number;
}

export interface CommentResult {
  url?: string;
}

/** A file's original bytes, as the app hands them over (Google Docs exported to Office formats). */
export interface ItemDownload {
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
  /** Where it lives in the app, for the file's source link. */
  url?: string;
}

/** One app. Every method uses only the token from ctx and never returns it. */
export interface ItemSource {
  /** Catalog id ("notion", "github", "atlassian"…). */
  id: string;
  provider: AccountProvider;
  label: string;
  /** What search can return, most useful first. Search without a kind covers these. */
  kinds: readonly AppItemKind[];
  /** True when this connection can read items; false hides it (e.g. Google without Drive). */
  usable?(token: ProviderToken): boolean;
  search(ctx: ItemContext, query: ItemSearch): Promise<AppItem[]>;
  read(ctx: ItemContext, ref: { kind: AppItemKind; id: string }): Promise<AppItemContent>;
  /** People in the workspace, team or organisation, for "Add people from …". */
  people?(ctx: ItemContext): Promise<AppItemPerson[]>;
  /** An item link (a task's source URL) → the item, when this app made it. */
  fromUrl?(url: string): { kind: AppItemKind; id: string } | null;
  /** Posts a comment on an issue, card or ticket. Called only after the person pressed Post. */
  comment?(ctx: ItemContext, ref: { kind: AppItemKind; id: string }, body: string): Promise<CommentResult>;
  /** A file or email attachment's original bytes, for bringing it into Files. At most MAX_DOWNLOAD_BYTES. */
  download?(ctx: ItemContext, ref: { kind: AppItemKind; id: string }): Promise<ItemDownload>;
}

/** The app refused or could not be reached. The message is safe to show; it never holds a token. */
export class ItemError extends Error {
  readonly expose = true;
  constructor(
    message: string,
    readonly statusCode = 424,
    /** The app's own reason code, when it gave one (Google's `exportSizeLimitExceeded`). */
    readonly reason?: string,
  ) {
    super(message);
    this.name = "ItemError";
  }
}
