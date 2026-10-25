function htmlText(html: string): string {
  return html
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .trim();
}

/** Files on the clipboard, unless they ride along with copied text: Word, Excel and browsers add a picture of the selection. */
export function pastedFiles(data: DataTransfer | null): File[] {
  const files = Array.from(data?.files ?? []);
  if (!data || !files.length) return [];
  const types = Array.from(data.types ?? []);
  if (types.includes("text/rtf")) return [];
  const html = types.includes("text/html") ? data.getData("text/html") : "";
  return html && htmlText(html) ? [] : files;
}
