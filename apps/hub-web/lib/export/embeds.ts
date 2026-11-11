"use client";

import type { DiagramModel } from "@ensemble/block-diagrams";
import type { Block, EmbedRef, ExportDoc, ImageBlock } from "./document";

/** CSS pixels a chart is drawn at; documents scale it to their text width. */
const CHART_WIDTH = 720;
/** Pictures drawn at once. Each one holds a chart or canvas in memory while it is made. */
const AT_ONCE = 3;

type Picture = Pick<ImageBlock, "png" | "format" | "width" | "height">;

async function bytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * A picture file as PNG or JPEG with its size. PNG and JPEG keep their own bytes; GIF, WebP and
 * the rest are drawn onto a canvas and saved as PNG, which every document format can hold.
 */
export async function pictureFrom(blob: Blob): Promise<Picture> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("This picture could not be read."));
      image.src = url;
    });
    const width = image.naturalWidth || 1;
    const height = image.naturalHeight || 1;
    if (blob.type === "image/png" || blob.type === "image/jpeg") {
      return { png: await bytes(blob), format: blob.type === "image/png" ? "png" : "jpg", width, height };
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This picture could not be drawn.");
    context.drawImage(image, 0, 0);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("This picture could not be drawn.");
    return { png: await bytes(png), format: "png", width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function plotImages(embed: EmbedRef): Promise<ImageBlock[]> {
  const [{ loadPlotFigures }, { renderChartForPrint }] = await Promise.all([import("@/lib/plots/figures"), import("@/components/plots/chart-view")]);
  const loaded = await loadPlotFigures(embed.id, embed.label);
  if (!loaded.figures.length) return [];
  const many = loaded.figures.length > 1;
  const out: ImageBlock[] = [];
  for (const figure of loaded.figures) {
    const height = Math.round(Math.min(CHART_WIDTH, Math.max(260, CHART_WIDTH / (figure.ratio || 1.6))));
    const drawn = await renderChartForPrint(figure.frame, figure.config, { width: CHART_WIDTH, height, pixelRatio: 2 });
    const name = (many ? figure.title : loaded.title) || embed.label || "Plot";
    out.push({ type: "image", kind: "plot", png: await bytes(drawn.png), format: "png", svg: drawn.svg || undefined, width: CHART_WIDTH, height, alt: name, caption: name, href: embed.href, fill: true });
  }
  return out;
}

async function diagramImage(embed: EmbedRef): Promise<ImageBlock[]> {
  const [{ api }, { laidOut }, { diagramFiles }] = await Promise.all([import("@/lib/api"), import("@/components/diagrams/layout-client"), import("@/components/diagrams/export-image")]);
  const { diagram } = await api.diagram(embed.id);
  const model = await laidOut(diagram.model as DiagramModel);
  // The caption names the diagram, so the drawing leaves its own title out.
  const files = await diagramFiles({ ...model, meta: { ...model.meta, title: "" } });
  if (!files.png) throw new Error("The diagram could not be drawn.");
  const box = /viewBox="[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)"/.exec(files.svg);
  const width = Number(box?.[1]) || 800;
  const height = Number(box?.[2]) || 600;
  const name = diagram.title || embed.label || "Diagram";
  return [{ type: "image", kind: "diagram", png: await bytes(files.png), format: "png", svg: files.svg, width, height, alt: name, caption: name, href: embed.href, fill: true }];
}

async function fileImage(embed: EmbedRef): Promise<ImageBlock[] | null> {
  const { filesApi } = await import("@/lib/api-files");
  const { file } = await filesApi.get(embed.id);
  // Only pictures are drawn. A PDF, Word file or deck stays a link to it in Ensemble.
  if (file.kind !== "image") return null;
  const picture = await pictureFrom(new Blob([await filesApi.original(embed.id)], { type: file.mediaType }));
  const name = file.filename || embed.label;
  return [{ type: "image", kind: "image", ...picture, alt: name, caption: name, href: embed.href }];
}

async function pageImage(embed: EmbedRef): Promise<ImageBlock[]> {
  let blob: Blob;
  if (embed.id) {
    const { loadPageImage } = await import("@/components/editor/page-image");
    blob = await loadPageImage(embed.id);
  } else if (embed.src) {
    const response = await fetch(embed.src, { mode: "cors", credentials: "omit" });
    if (!response.ok) throw new Error("This picture could not be fetched.");
    blob = await response.blob();
  } else return [];
  const picture = await pictureFrom(blob);
  return [{ type: "image", kind: "image", ...picture, alt: embed.label, href: embed.href, scale: embed.width ?? null, align: embed.align }];
}

async function draw(embed: EmbedRef): Promise<ImageBlock[] | null> {
  switch (embed.kind) {
    case "plot":
      return plotImages(embed);
    case "diagram":
      return diagramImage(embed);
    case "file":
      return fileImage(embed);
    case "image":
      return pageImage(embed);
  }
}

/**
 * The document with each plot, diagram and picture drawn as an image. Anything that cannot be
 * drawn (removed, not shared with this person, a PDF or Word attachment, a feature turned off)
 * stays an `embed`, which every format writes as a link to it in Ensemble.
 */
export async function resolveEmbeds(doc: ExportDoc): Promise<ExportDoc> {
  const drawn = new Map<number, Block[]>();
  const jobs = doc.blocks.flatMap((block, index) => (block.type === "embed" ? [{ index, embed: block.embed }] : []));
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      try {
        const images = await draw(job.embed);
        if (images) drawn.set(job.index, images.length ? images : [{ type: "embed", embed: job.embed }]);
      } catch {
        // Left as a link.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, jobs.length) }, worker));
  if (!drawn.size) return doc;
  return { ...doc, blocks: doc.blocks.flatMap((block, index) => drawn.get(index) ?? [block]) };
}
