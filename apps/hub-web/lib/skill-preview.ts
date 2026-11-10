/** A skill's Markdown without its YAML front matter, plus the front matter's one-line `key: value` fields. */
export function skillPreview(body: string): { meta: Array<[string, string]>; text: string } {
  const fence = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (!fence) return { meta: [], text: body };
  const meta = fence[1]!.split(/\r?\n/).flatMap((line): Array<[string, string]> => {
    const at = line.indexOf(":");
    return at > 0 && !/^\s/.test(line) ? [[line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["']|["']$/g, "")]] : [];
  });
  return { meta: meta.filter(([, value]) => value), text: body.slice(fence[0].length) };
}
