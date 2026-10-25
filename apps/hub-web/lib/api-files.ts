import type { FileImportSource, FileRecord, FileStyleProfile, FileUsage, PageDocument, SheetPatch } from "@ensemble/shared-types";
import { API, ApiError, api, del, get, itemViewHeaders, post, put, request, type ArtifactRecord } from "./api";

/** Files people uploaded or imported (routes/files.ts). Docs: docs/32_FILES.md. */
export const FILE_QUERY = {
  list: (q = "") => ["files", q] as const,
  one: (id: string) => ["files", "one", id] as const,
  original: (id: string, sha: string) => ["files", "original", id, sha] as const,
  sources: ["files", "import-sources"] as const,
  all: ["files"] as const,
};

const encode = encodeURIComponent;

/** Bytes → base64 without blowing the call stack on large files. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  return btoa(binary);
}

export const filesApi = {
  list: (q = "") => get<{ files: FileRecord[]; usage: FileUsage }>(`/api/documents${q ? `?q=${encode(q)}` : ""}`),
  get: (id: string) => get<{ file: FileRecord }>(`/api/documents/${encode(id)}`),
  /**
   * Uploads a file the person chose or dropped. With `onProgress`, reports 0–1 as it reads and sends.
   * `signal` stops it with an AbortError; the server may have saved the file already.
   * `summarize: false` skips the AI summary the server writes for new files.
   * `purpose: "page-image"` holds it to the page-image rules (2 MB, PNG/JPEG/GIF/WebP) and answers its size.
   */
  async upload(
    file: File | { name: string; type: string; bytes: Uint8Array },
    options: { onProgress?: (fraction: number) => void; signal?: AbortSignal; summarize?: boolean; purpose?: "page-image" } = {},
  ): Promise<{ file: FileRecord; image?: { format: string; width: number; height: number } }> {
    const { signal } = options;
    signal?.throwIfAborted();
    const bytes = file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : file.bytes;
    signal?.throwIfAborted();
    const body = {
      filename: file.name,
      mediaType: file.type || "application/octet-stream",
      dataBase64: toBase64(bytes),
      ...(options.summarize === undefined ? {} : { summarize: options.summarize }),
      ...(options.purpose ? { purpose: options.purpose } : {}),
    };
    type Uploaded = { file: FileRecord; image?: { format: string; width: number; height: number } };
    if (!options.onProgress || typeof XMLHttpRequest === "undefined") return request<Uploaded>("/api/documents", { method: "POST", json: body, signal });
    return sendWithProgress<Uploaded>("/api/documents", body, options.onProgress, signal);
  },
  /** The original bytes, for previews and conversions. */
  async original(id: string): Promise<ArrayBuffer> {
    // On a shared page or public link, the share header is what lets the server hand over a file mentioned there.
    const response = await fetch(`${API}/api/documents/${encode(id)}/original`, { credentials: "include", headers: itemViewHeaders() });
    if (!response.ok) {
      let message = `Could not open the file (${response.status}).`;
      try {
        message = ((await response.json()) as { error?: string }).error ?? message;
      } catch {
        // Not JSON; keep the status message.
      }
      throw new ApiError(message, response.status);
    }
    return response.arrayBuffer();
  },
  downloadUrl: (id: string) => `${API}/api/documents/${encode(id)}/original`,
  text: (id: string, offset = 0) => get<{ text: string; offset: number; total: number; nextOffset?: number }>(`/api/documents/${encode(id)}/text?offset=${offset}`),
  /** Replaces the file's bytes: a saved CSV, or an .xls made into an .xlsx (then filename and mediaType change too). */
  replace: (id: string, input: { bytes: Uint8Array; filename?: string; mediaType?: string }) =>
    put<{ file: FileRecord }>(`/api/documents/${encode(id)}/content`, {
      dataBase64: toBase64(input.bytes),
      ...(input.filename ? { filename: input.filename } : {}),
      ...(input.mediaType ? { mediaType: input.mediaType } : {}),
    }),
  /** Cell edits saved into the original .xlsx, keeping its formatting. */
  saveCells: (id: string, patch: SheetPatch) => post<{ file: FileRecord }>(`/api/documents/${encode(id)}/cells`, patch),
  /** Makes a page from the file. PDF and Word send the converted content and the formatting to keep; text and code are converted on the server. */
  toPage: (id: string, input: { title?: string; content?: PageDocument; style?: FileStyleProfile } = {}) =>
    post<{ pageId: string }>(`/api/documents/${encode(id)}/page`, input),
  style: (id: string) => get<{ style: FileStyleProfile | null }>(`/api/documents/${encode(id)}/style`),
  remove: (id: string) => del<void>(`/api/documents/${encode(id)}`),
  importSources: () => get<{ sources: FileImportSource[] }>("/api/documents/import-sources"),
  /** Brings a file in from a connected app (an app-items search hit of kind "file" or "attachment"). */
  importFromApp: (ref: { source: string; kind: string; id: string }) => post<{ file: FileRecord }>("/api/documents/import", ref),
  /** What the Google Picker needs. `accessToken` is null until Google Drive access is approved. */
  googlePicker: () => get<{ apiKey: string; appId: string; accessToken: string | null; origin: string }>("/api/connectors/google/picker"),
};

/** One item from a connected app, read in full (GET /api/artifacts/:id). */
export type AppItemDetail = ArtifactRecord & {
  text: string;
  participants: Array<{ name?: string | null; email?: string | null; handle?: string | null }>;
  authoredByMe: boolean;
  /** Set when this is an uploaded file's text: Files opens the file instead. */
  documentId: string | null;
};

/** Files → From your apps: what Ensemble synced or attached from connected apps (routes/context.ts). */
export const FROM_APPS_QUERY = {
  list: (q: string, kind: string) => ["artifacts", "from-apps", q, kind] as const,
  one: (id: string) => ["artifacts", "one", id] as const,
};

export const fromAppsApi = {
  list: (input: { q?: string; kind?: string; before?: string }) => api.artifacts({ ...input, exclude: "uploads", take: 50 }),
  get: (id: string) => get<{ artifact: AppItemDetail }>(`/api/artifacts/${encode(id)}`),
  /** Owner only. Uploaded files answer 409: delete them with `filesApi.remove`. */
  remove: (id: string) => del<void>(`/api/artifacts/${encode(id)}`),
};

/** A JSON POST over XMLHttpRequest, which (unlike fetch) reports upload progress. Errors read like `request`'s. */
function sendWithProgress<T>(path: string, body: unknown, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const stop = () => xhr.abort();
    const settle = () => signal?.removeEventListener("abort", stop);
    xhr.open("POST", `${API}${path}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", "application/json");
    // Like `request`: on a shared page or public link the server decides with the share header.
    for (const [name, value] of Object.entries(itemViewHeaders())) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total) onProgress(event.loaded / event.total);
    };
    xhr.onabort = () => {
      settle();
      reject(new DOMException("The upload was cancelled.", "AbortError"));
    };
    xhr.onerror = () => {
      settle();
      reject(new ApiError("Ensemble can't reach its server right now.", 0));
    };
    xhr.onload = () => {
      settle();
      const text = xhr.responseText ?? "";
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        try {
          resolve(JSON.parse(text) as T);
        } catch {
          reject(new ApiError("The server sent an answer Ensemble could not read.", xhr.status));
        }
        return;
      }
      let message = xhr.status === 413 ? "That file is too big to upload here." : `Upload failed (${xhr.status}).`;
      try {
        const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
        const said = typeof parsed.error === "string" ? parsed.error : typeof parsed.message === "string" ? parsed.message : null;
        if (said?.trim()) message = said.trim();
      } catch {
        // Not JSON; keep the status message.
      }
      reject(new ApiError(message, xhr.status));
    };
    if (signal?.aborted) return reject(new DOMException("The upload was cancelled.", "AbortError"));
    signal?.addEventListener("abort", stop, { once: true });
    xhr.send(JSON.stringify(body));
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
