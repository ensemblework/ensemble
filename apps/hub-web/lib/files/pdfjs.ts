"use client";

import { installStreamIteration } from "./stream-iteration";

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type Loaded = { pdfjs: Pdfjs; worker: ReturnType<Pdfjs["PDFWorker"]["create"]> };

let ready: Promise<Loaded> | null = null;

/**
 * pdf.js, loaded on first use, with one worker (a separate bundled chunk) shared by every
 * document. Documents are given the worker explicitly, so closing one never stops the
 * worker under another. Bytes handed to pdf.js move to the worker: pass a copy of any
 * buffer you keep.
 *
 * This is pdf.js's legacy build: the modern one calls built-ins only the newest browsers have
 * (Map#getOrInsertComputed, Math.sumPrecise, Promise.try), so PDFs failed in Safari and in the
 * WebKit view the macOS desktop app runs in. The legacy build carries polyfills for those; the
 * one it lacks, iterating a stream, is installed here and in the worker (stream-iteration.ts).
 */
export function loadPdfjs(): Promise<Loaded> {
  if (!ready) installStreamIteration();
  ready ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => ({
    pdfjs,
    worker: pdfjs.PDFWorker.create({ port: new Worker(new URL("./pdf-worker.ts", import.meta.url)) }),
  }));
  ready.catch(() => {
    ready = null;
  });
  return ready;
}
