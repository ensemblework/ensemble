/**
 * `hub_read_web_page`: reads a public web page or PDF for the assistant, so an answer can rest on the
 * source itself rather than a search snippet. Fetched here with save-file.ts's guards (http(s) only,
 * every address and redirect checked against private networks, a size cap and a time limit), then read
 * like a node's browser_extract (browser/extract.ts: main content as Markdown, products and prices from
 * structured data). It runs no page script and signs in nowhere: pages built by scripts, or behind a
 * sign-in, are work for an Ensemble Node's browser on a paired computer.
 */
import { z } from "zod";
import { extractHtml } from "../../browser/extract.js";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool } from "../types.js";
import { fetchPublicFile, SaveFileError } from "./save-file.js";

/** UTF-8, or UTF-16 when a byte order mark says so (as files/extract.ts decodeText). */
function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  return new TextDecoder("utf-8").decode(bytes);
}

const MAX_PAGE_BYTES = 10 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 20_000;
/** The page text sent to the model; the loop cuts a result at 6,000 characters (agent.ts), so this leaves room for the rest. */
export const PAGE_TEXT_CHARS = 4_500;
const MAX_PRODUCTS = 8;

export type PageReading = {
  title: string;
  url: string;
  text: string;
  /** Characters of readable text on the page, before cutting. */
  chars: number;
  truncated: boolean;
  part?: string;
  products?: Array<Record<string, unknown>>;
  note?: string;
};

/** What a fetched page or file says, as the model reads it. */
export async function readFetched(fetched: { bytes: Buffer; url: string; contentType: string }, focus?: string): Promise<PageReading> {
  const { bytes, url, contentType } = fetched;
  const pdf = contentType === "application/pdf" || bytes.subarray(0, 1024).toString("latin1").includes("%PDF-");
  if (pdf) {
    // Loaded only for a PDF: the file reader brings the database client with it.
    const { binaryText } = await import("../../files/extract.js");
    const read = await binaryText("pdf", bytes);
    if (!read.text.trim()) return { title: "", url, text: "", chars: 0, truncated: false, note: read.warnings[0] ?? "This PDF has no text to read (it may be scanned)." };
    const text = read.text.slice(0, PAGE_TEXT_CHARS);
    return { title: "", url, text, chars: read.text.length, truncated: read.text.length > text.length, part: `PDF, ${read.pageCount ?? "?"} pages` };
  }
  const raw = decodeText(bytes);
  const html = /html|xml/.test(contentType) || /^\s*</.test(raw.slice(0, 200));
  if (!html) {
    const text = raw.slice(0, PAGE_TEXT_CHARS);
    return { title: "", url, text, chars: raw.length, truncated: raw.length > text.length };
  }
  const page = extractHtml(raw, { url, maxChars: PAGE_TEXT_CHARS, ...(focus ? { focus } : {}) });
  const products = page.products.slice(0, MAX_PRODUCTS).map((product) => Object.fromEntries(Object.entries(product).filter(([, value]) => value !== null && value !== undefined)));
  const thin = page.chars < 300;
  return {
    title: page.title,
    url,
    text: page.markdown,
    chars: page.chars,
    truncated: page.truncated,
    part: page.part,
    ...(products.length ? { products } : {}),
    ...(thin
      ? { note: "Little text came back: the page is probably built by scripts or behind a sign-in. Try another source from the search, or say it could not be read." }
      : page.truncated
        ? { note: `Only the start of the page is shown (${PAGE_TEXT_CHARS} of ${page.chars} characters). To read another part, call again with focus: words that name it.` }
        : {}),
  };
}

export const webPageTools: AnyHubTool[] = [
  defineTool({
    name: "hub_read_web_page",
    area: "context",
    description:
      "Read a public web page or PDF by its link: its main text as Markdown, and the products and prices it publishes. " +
      "Use it after hub_web_search to read the source itself before you answer (versions, dates, prices, specs, what a page says), or on a link the person gave. " +
      "focus: a few words naming the part you need (\"release schedule\", \"specifications\", \"pricing\"). " +
      "It cannot sign in, click or run the page's scripts; a page that comes back nearly empty needs another source.",
    input: z.object({
      url: z.string().min(8).max(2000).describe("The page's full http(s) link, from search results or the person."),
      focus: z.string().max(120).optional().describe("Words naming the part of the page to read."),
    }),
    isWrite: false,
    risk: "low",
    async run(_ctx, input) {
      let fetched;
      try {
        fetched = await fetchPublicFile(input.url, MAX_PAGE_BYTES, undefined, PAGE_TIMEOUT_MS, true);
      } catch (error) {
        if (error instanceof SaveFileError) {
          const blocked = /answered (401|403|429|503)/.test(error.message);
          throw new ToolBlockedError(
            error.message.replace("That link", "That page"),
            blocked ? "The site refuses automated reads. Use another source from the search, or say this one could not be read." : undefined,
          );
        }
        throw error;
      }
      const page = await readFetched(fetched, input.focus);
      const where = page.title ? `“${page.title}”` : new URL(page.url).hostname;
      return toolOk(page.text ? `Read ${where}.` : `Could not read text from ${where}.`, page);
    },
  }),
];
