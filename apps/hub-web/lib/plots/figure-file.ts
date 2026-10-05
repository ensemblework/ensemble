/** Matplotlib returns PNG, PDF, and EPS as base64. SVG comes back as the XML text. */
export function figureBytes(format: string, data: string): Blob {
  const text = data.trimStart();
  if (format === "svg" || text.startsWith("<") || text.startsWith("<?xml")) {
    return new Blob([data], { type: "image/svg+xml" });
  }
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const type = format === "png" ? "image/png" : format === "pdf" ? "application/pdf" : format === "eps" ? "application/postscript" : "application/octet-stream";
  return new Blob([bytes], { type });
}
