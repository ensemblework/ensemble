/** Test fixtures for files: a PDF built by hand, so tests need no PDF writer. */

/** A minimal PDF with one line of text per page (an empty string makes a page without text). */
export function makePdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  add("");
  add("");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  for (const text of pages) {
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, (char) => `\\${char}`)}) Tj ET` : "";
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
