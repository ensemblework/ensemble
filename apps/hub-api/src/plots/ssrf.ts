import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 15_000;

const ALLOWED = [
  "docs.google.com",
  "drive.google.com",
  "drive.usercontent.google.com",
  "1drv.ms",
  "onedrive.live.com",
];

export class SsrfError extends Error {
  readonly expose = true;
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

export function isBlockedAddress(address: string): boolean {
  const mapped = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (mapped.includes(":")) {
    const lower = mapped.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80")) return true;
    return false;
  }
  const parts = mapped.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && parts[2] === 2) return true;
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  if (a >= 224) return true;
  return false;
}

function hostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (ALLOWED.includes(host)) return true;
  if (host.endsWith(".files.1drv.com")) return true;
  if (host.endsWith(".sharepoint.com")) return true;
  return false;
}

/** Rewrite public editor links to a direct export. Other URLs pass through. */
export function normalizeSheetUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SsrfError("That link is not a URL.");
  }
  if (url.protocol !== "https:") throw new SsrfError("Only https links can be imported.");
  if (url.username || url.password) throw new SsrfError("Links with a username or password are refused.");
  const sheets = url.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (url.hostname === "docs.google.com" && sheets) {
    const gid = url.searchParams.get("gid");
    const next = new URL(`https://docs.google.com/spreadsheets/d/${sheets[1]}/export`);
    next.searchParams.set("format", "xlsx");
    if (gid && /^\d+$/.test(gid)) next.searchParams.set("gid", gid);
    return next.toString();
  }
  const drive = url.pathname.match(/\/file\/d\/([a-zA-Z0-9-_]+)/);
  if (url.hostname === "drive.google.com" && drive) {
    return `https://drive.google.com/uc?export=download&id=${drive[1]}`;
  }
  if (url.hostname === "1drv.ms" || url.hostname === "onedrive.live.com") {
    if (!url.searchParams.has("download")) url.searchParams.set("download", "1");
    return url.toString();
  }
  return url.toString();
}

export type LookupFn = (hostname: string) => Promise<string[]>;
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

async function assertPublic(hostname: string, resolve: LookupFn): Promise<void> {
  if (!hostAllowed(hostname)) throw new SsrfError("That host is not a spreadsheet link Ensemble can fetch. Use a public Google Sheets, Drive, OneDrive, or SharePoint link.");
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new SsrfError("That address is not reachable from Plots.");
    return;
  }
  let addresses: string[] = [];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new SsrfError("That host did not resolve.");
  }
  if (!addresses.length || addresses.some((address) => isBlockedAddress(address))) {
    throw new SsrfError("That host points at a private address.");
  }
}

export async function fetchPublicTable(
  raw: string,
  deps: { lookup?: LookupFn; fetch?: FetchFn } = {},
): Promise<{ bytes: Uint8Array; filename: string; contentType: string }> {
  const resolve = deps.lookup ?? (async (hostname: string) => (await lookup(hostname, { all: true })).map((row) => row.address));
  const request = deps.fetch ?? fetch;
  let current = normalizeSheetUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = new URL(current);
    await assertPublic(url.hostname, resolve);
    const response = await request(current, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new SsrfError("The link redirected without a destination.");
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new SsrfError("That link did not return a file. If it needs a sign-in, use a public export link.");
    const contentType = response.headers.get("content-type") ?? "";
    if (/text\/html/i.test(contentType)) throw new SsrfError("That link opened a web page, not a file. Share it so anyone with the link can download it.");
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (!reader) {
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > MAX_BYTES) throw new SsrfError("That file is larger than 32 MB.");
      return { bytes: buffer, filename: filenameFrom(url, contentType), contentType };
    }
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      total += step.value.byteLength;
      if (total > MAX_BYTES) throw new SsrfError("That file is larger than 32 MB.");
      chunks.push(step.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, filename: filenameFrom(url, contentType), contentType };
  }
  throw new SsrfError("That link redirected too many times.");
}

function filenameFrom(url: URL, contentType: string): string {
  const last = url.pathname.split("/").pop() || "download";
  if (/\.(csv|tsv|txt|json|jsonl|xlsx|xls|xlsm|ods|numbers|parquet|feather|arrow)$/i.test(last)) return last;
  if (contentType.includes("spreadsheet") || url.searchParams.get("format") === "xlsx") return "sheet.xlsx";
  if (contentType.includes("csv") || url.searchParams.get("format") === "csv") return "sheet.csv";
  return last.slice(0, 80) || "download";
}
