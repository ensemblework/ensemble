import { DIAGRAM_PAPER, renderDiagramSvg, type DiagramModel, type DiagramTheme } from "@ensemble/block-diagrams";

export type DiagramExportKind = "png" | "jpg" | "pdf" | "svg";

function filename(title: string): string {
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || "diagram";
}

function currentTheme(): DiagramTheme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function saveUrl(href: string, name: string) {
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function draw(model: DiagramModel, theme: DiagramTheme): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  const svg = renderDiagramSvg(model, { theme });
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? "0 0 800 600";
  const parts = viewBox.split(/\s+/).map(Number);
  const width = Math.max(1, parts[2] ?? 800);
  const height = Math.max(1, parts[3] ?? 600);
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Could not draw the diagram."));
      image.src = url;
    });
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not draw the diagram.");
    context.fillStyle = DIAGRAM_PAPER[theme];
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { canvas, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function copyDiagramPng(model: DiagramModel): Promise<void> {
  const { canvas } = await draw(model, currentTheme());
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((value) => resolve(value), "image/png"));
  if (!blob || typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("Couldn't copy the image.");
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

export async function downloadDiagram(model: DiagramModel, kind: DiagramExportKind): Promise<void> {
  const theme = currentTheme();
  const name = filename(model.meta.title);
  if (kind === "svg") {
    const blob = new Blob([renderDiagramSvg(model, { theme })], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    saveUrl(url, `${name}.svg`);
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    return;
  }
  const { canvas, width, height } = await draw(model, theme);
  if (kind === "pdf") {
    const { jsPDF } = await import("jspdf");
    const pdf = new jsPDF({ orientation: width > height ? "landscape" : "portrait", unit: "pt", format: [width, height] });
    pdf.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, width, height);
    pdf.save(`${name}.pdf`);
    return;
  }
  const mime = kind === "jpg" ? "image/jpeg" : "image/png";
  saveUrl(canvas.toDataURL(mime, 0.92), `${name}.${kind}`);
}
