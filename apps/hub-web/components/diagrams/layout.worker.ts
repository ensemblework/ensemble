import type { DiagramModel } from "@ensemble/block-diagrams";
import { layoutDiagram, type LayoutFit } from "@ensemble/block-diagrams/layout";

// elkjs treats a worker that has no `document` as its own worker thread and
// then refuses to export the in-thread layout constructor. A stand-in keeps
// Reorganize off the main thread.
if (typeof document === "undefined") {
  (globalThis as { document?: object }).document = {};
}

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; model: DiagramModel; fit?: LayoutFit }>) => void) | null;
  postMessage: (data: unknown) => void;
};

scope.onmessage = (event) => {
  layoutDiagram(event.data.model, event.data.fit)
    .then((model) => scope.postMessage({ id: event.data.id, model }))
    .catch((error: unknown) => {
      scope.postMessage({ id: event.data.id, error: error instanceof Error ? error.message : "Layout failed" });
    });
};
