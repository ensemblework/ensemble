/**
 * Reads only the entries an importer wants from an uploaded zip, counting
 * real inflated bytes as they arrive so a zip bomb stops early.
 */
import { Unzip, UnzipInflate } from "fflate";
import { ImportError } from "../types.js";

/** One allowance of inflated bytes shared by every unzip of one upload, nested zips included. */
export interface UnzipBudget {
  remaining: number;
}

export function unzipBudget(bytes: number): UnzipBudget {
  return { remaining: bytes };
}

export interface SafeUnzipOptions {
  want: (name: string) => boolean;
  /** Spent as real inflated bytes arrive; the unzip stops when it runs out. */
  budget: UnzipBudget;
  maxEntries: number;
  /** Largest single inflated entry. */
  maxEntryBytes?: number;
}

export function isZip(data: Uint8Array): boolean {
  return data.length > 4 && data[0] === 0x50 && data[1] === 0x4b && (data[2] === 0x03 || data[2] === 0x05) && (data[3] === 0x04 || data[3] === 0x06);
}

export function safeUnzip(data: Uint8Array, options: SafeUnzipOptions): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let entries = 0;
  let failure: ImportError | null = null;
  const unzip = new Unzip((file) => {
    if (failure) return;
    entries += 1;
    if (entries > options.maxEntries) {
      failure = new ImportError(`That zip has more than ${options.maxEntries} files. Export a smaller part of the workspace.`, 413);
      return;
    }
    const name = file.name.replace(/\\/g, "/");
    if (name.endsWith("/") || name.split("/").includes("..") || name.startsWith("/") || !options.want(name)) return;
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) {
        failure = new ImportError("Part of that zip is damaged. Export it again and retry.", 400);
        return;
      }
      size += chunk.length;
      options.budget.remaining -= chunk.length;
      if (options.budget.remaining < 0 || (options.maxEntryBytes && size > options.maxEntryBytes)) {
        failure = new ImportError("That zip unpacks to more than Ensemble imports at once. Export a smaller part and import each.", 413);
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) {
        const out = new Uint8Array(size);
        let offset = 0;
        for (const part of chunks) {
          out.set(part, offset);
          offset += part.length;
        }
        files.set(name, out);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    unzip.push(data, true);
  } catch (error) {
    if (failure) throw failure;
    throw new ImportError("That zip could not be read. Export it again and retry.", 400, { cause: error });
  }
  if (failure) throw failure;
  return files;
}
