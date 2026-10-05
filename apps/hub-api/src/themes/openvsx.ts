import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { parseJsonc } from "@ensemble/ide-theme";
import { convertExtensionThemes, listPackageThemes, sanitizeIdeTheme } from "@ensemble/ide-theme";
import type { ConvertedExtensionTheme, IdeTheme, ThemeDirectoryExtension } from "@ensemble/ide-theme";

export const VSIX_MAX_BYTES = 12 * 1024 * 1024;
const THEME_JSON_MAX_BYTES = 512 * 1024;
const JSON_TOTAL_MAX_BYTES = 2 * 1024 * 1024;
const NS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VER = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export class ThemeFetchError extends Error {
  statusCode: number;
  expose = true;
  constructor(message: string, statusCode = 422) {
    super(message);
    this.name = "ThemeFetchError";
    this.statusCode = statusCode;
  }
}

export type ThemeCache = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
};

export type ThemeDeps = {
  fetchImpl?: typeof fetch;
  cache?: ThemeCache;
  maxVsixBytes?: number;
};

export function assertOpenVsxUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ThemeFetchError("That theme address is not valid.");
  }
  if (url.protocol !== "https:" || url.hostname !== "open-vsx.org" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new ThemeFetchError("Themes can only be downloaded from open-vsx.org.");
  }
  return url;
}

export class DiskThemeCache implements ThemeCache {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    const parts = key.split("/").filter(Boolean);
    if (!parts.length || parts.some((part) => part === ".." || part === "." || !/^[A-Za-z0-9._@+-]+$/.test(part))) {
      throw new ThemeFetchError("Invalid cache key.");
    }
    return path.join(this.root, ...parts) + ".json";
  }

  async get(key: string): Promise<string | null> {
    const file = this.resolve(key);
    try {
      return await readFile(file, "utf8");
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, value);
  }
}

export async function fetchOpenVsxBytes(
  url: string,
  opts: { maxBytes: number; fetchImpl?: typeof fetch; redirectsLeft?: number },
): Promise<Uint8Array> {
  const target = assertOpenVsxUrl(url);
  const fetchImpl = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(target.toString(), { redirect: "manual" });
  } catch {
    throw new ThemeFetchError("Ensemble couldn't reach the theme directory.", 502);
  }
  if (response.status >= 300 && response.status < 400) {
    const left = opts.redirectsLeft ?? 2;
    if (left <= 0) throw new ThemeFetchError("The theme download was redirected too many times.");
    const location = response.headers.get("location");
    if (!location) throw new ThemeFetchError("The theme download was redirected without a destination.");
    const next = new URL(location, target).toString();
    assertOpenVsxUrl(next);
    return fetchOpenVsxBytes(next, { ...opts, redirectsLeft: left - 1 });
  }
  if (!response.ok) {
    throw new ThemeFetchError("The theme directory didn't return that file.", response.status === 404 ? 404 : 502);
  }
  return readBounded(response, opts.maxBytes);
}

export function jsonFilesFromVsix(bytes: Uint8Array): Map<string, string> {
  let unpacked: Record<string, Uint8Array>;
  try {
    unpacked = unzipSync(bytes, {
      filter(file) {
        const name = file.name.replace(/\\/g, "/");
        return name.startsWith("extension/") && name.endsWith(".json") && !name.includes("..") && file.originalSize <= THEME_JSON_MAX_BYTES;
      },
    });
  } catch (error) {
    if (error instanceof ThemeFetchError) throw error;
    throw new ThemeFetchError("That download isn't a valid theme package.");
  }
  const files = new Map<string, string>();
  let total = 0;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for (const [name, data] of Object.entries(unpacked)) {
    if (data.byteLength > THEME_JSON_MAX_BYTES) continue;
    total += data.byteLength;
    if (total > JSON_TOTAL_MAX_BYTES) break;
    const rel = name.replace(/\\/g, "/").replace(/^extension\//, "");
    if (!rel.endsWith(".json") || rel.includes("..")) continue;
    files.set(rel, decoder.decode(data));
  }
  if (!files.has("package.json")) throw new ThemeFetchError("That package has no theme manifest.");
  return files;
}

export async function searchThemes(query: string, deps: ThemeDeps = {}): Promise<{ extensions: ThemeDirectoryExtension[] }> {
  const q = query.trim().slice(0, 80);
  if (q.length < 2) return { extensions: [] };
  const url = `https://open-vsx.org/api/-/search?query=${encodeURIComponent(q)}&category=Themes&size=8&sortBy=relevance&sortOrder=desc`;
  const bytes = await fetchOpenVsxBytes(url, { maxBytes: 512 * 1024, fetchImpl: deps.fetchImpl });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ThemeFetchError("The theme directory returned something Ensemble couldn't read.", 502);
  }
  const hits = parseHits(body).slice(0, 8);
  const extensions = await mapPool(hits, 4, (hit) => describeHit(hit, deps));
  return { extensions };
}

export async function loadOpenVsxTheme(
  query: { namespace: string; name: string; version: string; label: string },
  deps: ThemeDeps = {},
): Promise<{ theme: IdeTheme | null; reason?: string }> {
  if (!NS.test(query.namespace) || !NS.test(query.name) || !VER.test(query.version) || !query.label || query.label.length > 80) {
    throw new ThemeFetchError("That theme address is not valid.");
  }
  const key = `ext/${query.namespace}/${query.name}/${query.version}`;
  const cached = await deps.cache?.get(key);
  const stored = cached ? readCached(cached) : null;
  const payload = stored ?? (await downloadAndConvert(query, deps));
  if (!stored) await deps.cache?.set(key, JSON.stringify(payload));
  if (payload.note && payload.themes.length === 0) return { theme: null, reason: payload.note };
  const wanted =
    payload.themes.find((item) => item.label === query.label) ??
    payload.themes.find((item) => item.label.toLowerCase() === query.label.toLowerCase());
  if (!wanted) return { theme: null, reason: "That theme isn't in this extension." };
  if (!wanted.theme) return { theme: null, reason: wanted.reason ?? "This theme can't be applied." };
  return { theme: wanted.theme };
}

async function downloadAndConvert(
  query: { namespace: string; name: string; version: string; label: string },
  deps: ThemeDeps,
): Promise<{ themes: ConvertedExtensionTheme[]; note?: string }> {
  const metaUrl = `https://open-vsx.org/api/${encodeURIComponent(query.namespace)}/${encodeURIComponent(query.name)}/${encodeURIComponent(query.version)}`;
  const metaBytes = await fetchOpenVsxBytes(metaUrl, { maxBytes: 1024 * 1024, fetchImpl: deps.fetchImpl });
  let meta: unknown;
  try {
    meta = JSON.parse(new TextDecoder().decode(metaBytes)) as unknown;
  } catch {
    throw new ThemeFetchError("The theme directory returned something Ensemble couldn't read.", 502);
  }
  const download = meta && typeof meta === "object" ? (meta as { files?: { download?: unknown } }).files?.download : undefined;
  if (typeof download !== "string") throw new ThemeFetchError("This extension has no downloadable package.");
  const vsix = await fetchOpenVsxBytes(download, { maxBytes: deps.maxVsixBytes ?? VSIX_MAX_BYTES, fetchImpl: deps.fetchImpl });
  const files = jsonFilesFromVsix(vsix);
  let pkg: unknown;
  try {
    pkg = parseJsonc(files.get("package.json") ?? "");
  } catch {
    throw new ThemeFetchError("That package's manifest isn't valid JSON.");
  }
  const publisher = publisherOf(pkg) || query.namespace;
  return convertExtensionThemes({ ...query, publisher, packageJson: pkg, files });
}

async function describeHit(
  hit: Omit<ThemeDirectoryExtension, "themes" | "note">,
  deps: ThemeDeps,
): Promise<ThemeDirectoryExtension> {
  const key = `manifest/${hit.namespace}/${hit.name}/${hit.version}`;
  let text = (await deps.cache?.get(key)) ?? null;
  if (!text) {
    try {
      const url = `https://open-vsx.org/api/${encodeURIComponent(hit.namespace)}/${encodeURIComponent(hit.name)}/${encodeURIComponent(hit.version)}/file/package.json`;
      const bytes = await fetchOpenVsxBytes(url, { maxBytes: THEME_JSON_MAX_BYTES, fetchImpl: deps.fetchImpl });
      text = new TextDecoder().decode(bytes);
      await deps.cache?.set(key, text);
    } catch {
      return { ...hit, themes: [], note: "Couldn't read this extension's theme list." };
    }
  }
  let pkg: unknown;
  try {
    pkg = parseJsonc(text);
  } catch {
    return { ...hit, themes: [], note: "Couldn't read this extension's theme list." };
  }
  const listed = listPackageThemes(pkg, hit);
  return {
    ...hit,
    publisher: publisherOf(pkg) || hit.publisher,
    themes: listed.themes.map(({ path: _path, ...theme }) => theme),
    note: listed.note,
  };
}

function readCached(text: string): { themes: ConvertedExtensionTheme[]; note?: string } | null {
  try {
    const parsed = JSON.parse(text) as { themes?: ConvertedExtensionTheme[]; note?: string };
    if (!Array.isArray(parsed.themes)) return null;
    return {
      note: parsed.note,
      themes: parsed.themes.map((item) => {
        if (!item.theme) return item;
        const clean = sanitizeIdeTheme(item.theme);
        return clean ? { ...item, theme: clean } : { ...item, supported: false, theme: undefined, reason: "The saved theme was discarded." };
      }),
    };
  } catch {
    return null;
  }
}

function parseHits(body: unknown): Array<Omit<ThemeDirectoryExtension, "themes" | "note">> {
  if (!body || typeof body !== "object") return [];
  const extensions = (body as { extensions?: unknown }).extensions;
  if (!Array.isArray(extensions)) return [];
  const hits: Array<Omit<ThemeDirectoryExtension, "themes" | "note">> = [];
  for (const row of extensions) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    if (typeof item.namespace !== "string" || typeof item.name !== "string" || typeof item.version !== "string") continue;
    if (!NS.test(item.namespace) || !NS.test(item.name) || !VER.test(item.version)) continue;
    hits.push({
      namespace: item.namespace,
      name: item.name,
      version: item.version,
      displayName: typeof item.displayName === "string" ? item.displayName.slice(0, 80) : item.name,
      publisher: item.namespace,
      description: typeof item.description === "string" ? item.description.slice(0, 180) : "",
      downloadCount: typeof item.downloadCount === "number" && Number.isFinite(item.downloadCount) ? Math.max(0, Math.floor(item.downloadCount)) : 0,
    });
  }
  return hits;
}

function publisherOf(pkg: unknown): string {
  if (!pkg || typeof pkg !== "object") return "";
  const publisher = (pkg as { publisher?: unknown }).publisher;
  return typeof publisher === "string" ? publisher.slice(0, 80) : "";
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new ThemeFetchError("That download is larger than Ensemble allows.");
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new ThemeFetchError("That download is larger than Ensemble allows.");
    return buf;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ThemeFetchError("That download is larger than Ensemble allows.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
