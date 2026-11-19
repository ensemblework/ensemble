import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { GOOGLE_PRODUCT_SCOPES, productState, SUITES } from "../connectors/products.js";
import { ConnectorNotConnectedError, requireProviderToken } from "../connectors/tokens.js";
import { loadSettings } from "../lib/settings.js";
import { ORIGINAL_SELECT, originalBytes } from "./originals.js";
import { FileError } from "./store.js";

const UPLOAD = new URL("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id");
const UploadedFile = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]+$/) });

const uploadError = (status: number) => new FileError(`Google Drive could not save the copy (${status}).`, 424);

async function uploadRequest(url: URL, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(90_000) });
  } catch {
    throw new FileError("Could not reach Google Drive to save the copy.", 424);
  }
}

export async function exportFileToGoogleDrive(db: PrismaClient, userId: string, id: string): Promise<{ id: string; name: string; link: string }> {
  const file = await db.document.findFirst({
    where: { id, userId, deletedAt: null },
    select: { filename: true, mediaType: true, ...ORIGINAL_SELECT },
  });
  if (!file) throw new FileError("File not found.", 404);
  const settings = await loadSettings(db, userId);
  if (!productState(SUITES.google_workspace!, settings).drive_docs) {
    throw new ConnectorNotConnectedError("google", "Turn on Drive in Settings → Connections to save a copy.");
  }
  const { token } = await requireProviderToken(userId, "google", GOOGLE_PRODUCT_SCOPES.drive_docs, "Google Drive");
  const bytes = await originalBytes(file);
  const mediaType = file.mediaType || "application/octet-stream";
  const authorization = `Bearer ${token}`;
  const session = await uploadRequest(UPLOAD, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      "X-Upload-Content-Type": mediaType,
      "X-Upload-Content-Length": String(bytes.length),
    },
    body: JSON.stringify({ name: file.filename }),
  });
  if (!session.ok) throw uploadError(session.status);
  const location = session.headers.get("location");
  const destination = location ? URL.parse(location) : null;
  if (!destination || destination.origin !== UPLOAD.origin || destination.pathname !== UPLOAD.pathname || !destination.searchParams.get("upload_id") || destination.username || destination.password) {
    throw new FileError("Google Drive did not return a valid upload destination.", 424);
  }
  const uploaded = await uploadRequest(destination, {
    method: "PUT",
    headers: { Authorization: authorization, "Content-Type": mediaType, "Content-Length": String(bytes.length) },
    body: bytes,
  });
  if (!uploaded.ok) throw uploadError(uploaded.status);
  const result = UploadedFile.safeParse(await uploaded.json().catch(() => null));
  if (!result.success) throw new FileError("Google Drive did not return a file ID. Check Drive before trying again.", 424);
  return { id: result.data.id, name: file.filename, link: `https://drive.google.com/open?id=${result.data.id}` };
}
