"use client";

type Pdfjs = typeof import("pdfjs-dist");
type Loaded = { pdfjs: Pdfjs; worker: ReturnType<Pdfjs["PDFWorker"]["create"]> };

let ready: Promise<Loaded> | null = null;

/**
 * pdf.js, loaded on first use, with one worker (a separate bundled chunk) shared by every
 * document. Documents are given the worker explicitly, so closing one never stops the
 * worker under another. Bytes handed to pdf.js move to the worker: pass a copy of any
 * buffer you keep.
 */
export function loadPdfjs(): Promise<Loaded> {
  ready ??= import("pdfjs-dist").then((pdfjs) => ({
    pdfjs,
    worker: pdfjs.PDFWorker.create({ port: new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)) }),
  }));
  ready.catch(() => {
    ready = null;
  });
  return ready;
}
