import type { DiagramModel } from "@ensemble/block-diagrams";
import { layoutDiagram, type LayoutFit } from "@ensemble/block-diagrams/layout";

type Reply = { id: number; model?: DiagramModel; error?: string };

let worker: Worker | null = null;
let failed = false;
let seq = 0;
const pending = new Map<number, { resolve: (model: DiagramModel) => void; reject: (error: Error) => void }>();

function ensureWorker(): Worker | null {
  if (failed || typeof window === "undefined" || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./layout.worker.ts", import.meta.url));
    worker.onmessage = (event: MessageEvent<Reply>) => {
      const job = pending.get(event.data.id);
      if (!job) return;
      pending.delete(event.data.id);
      if (event.data.model) job.resolve(event.data.model);
      else job.reject(new Error(event.data.error ?? "Layout failed"));
    };
    worker.onerror = () => {
      failed = true;
      worker?.terminate();
      worker = null;
      for (const [id, job] of pending) {
        pending.delete(id);
        job.reject(new Error("Layout worker failed"));
      }
    };
    return worker;
  } catch {
    failed = true;
    return null;
  }
}

/** ELK in a worker when the browser can start one, otherwise on this thread. */
export function layoutInBackground(model: DiagramModel, fit?: LayoutFit): Promise<DiagramModel> {
  const current = ensureWorker();
  if (!current) return layoutDiagram(model, fit);
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      layoutDiagram(model, fit).then(resolve, reject);
    }, 12_000);
    pending.set(id, {
      resolve: (next) => {
        window.clearTimeout(timer);
        resolve(next);
      },
      reject: (error) => {
        window.clearTimeout(timer);
        layoutDiagram(model, fit).then(resolve, () => reject(error));
      },
    });
    try {
      current.postMessage({ id, model, fit });
    } catch (error) {
      pending.delete(id);
      window.clearTimeout(timer);
      layoutDiagram(model, fit).then(resolve, reject);
      void error;
    }
  });
}
