/**
 * A live check of the web tools against real sites (not in CI: it needs Chromium and the internet,
 * and sites change). It runs the tools through the browser broker exactly as a node's computer does:
 * Amazon's delivery ZIP, `browser_shop` over the top US stores for a ZIP in Wisconsin, focused chart
 * screenshots on Google Finance and Yahoo Finance, a CVF paper fetched as a PDF, and a page read as
 * Markdown. Screenshots and a JSON report go to the output folder; look at the pictures.
 *
 *   DATABASE_URL=postgresql://localhost/unused npx tsx apps/hub-api/scripts/browser-live-check.mjs --out ./live-check
 *   … --only shop,charts            (amazon, shop, charts, pdf, extract)
 *
 * It uses its own browser profile in the output folder, never the computer's Ensemble profile.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BrowserBroker } from "../src/browser/broker.ts";
import { runBrowserTool } from "../src/browser/tools.ts";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const out = resolve(option("out") ?? `browser-live-check-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const only = option("only")?.split(",").map((value) => value.trim()) ?? null;
const evidenceDir = join(out, "evidence");
mkdirSync(evidenceDir, { recursive: true });

const broker = new BrowserBroker({ dataHome: join(out, "data"), log: (message) => process.env.LIVE_CHECK_DEBUG && console.error(message) });
const context = { operation: "live-check", evidenceDir };
const report = [];

const PDF_URL = "https://openaccess.thecvf.com/content/CVPR2026F/papers/Sharma_BMD-45_A_Large-Scale_CCTV_Vehicle_Detection_Dataset_for_Urban_Traffic_CVPRF_2026_paper.pdf";

async function call(name, input) {
  const started = Date.now();
  const answer = await runBrowserTool(broker, name, input, context);
  const ms = Date.now() - started;
  return { answer, ms };
}

function record(check, ok, details) {
  report.push({ check, ok, ...details });
  console.log(`${ok ? "PASS" : "WARN"}  ${check}${details.note ? `: ${details.note}` : ""}`);
}

const want = (name) => !only || only.includes(name);

try {
  if (want("amazon")) {
    const { answer, ms } = await call("browser_set_location", { site: "amazon", location: "53703" });
    const shown = answer.ok ? answer.result.shown : "";
    record("Amazon delivers to ZIP 53703", answer.ok && /53703/.test(shown), { ms, note: answer.ok ? `Amazon shows “${shown}”` : answer.error.message, summary: answer.ok ? answer.summary : undefined });
    const view = await call("browser_view", { url: "https://www.amazon.com/s?k=PS5+console", location: "53703", name: "amazon-view" });
    record("Amazon search shows prices for 53703", view.answer.ok && /\$\d/.test(view.answer.result.text) && /53703/.test(view.answer.result.location?.shown ?? ""), {
      ms: view.ms,
      screenshot: view.answer.ok ? view.answer.result.file?.path : undefined,
      note: view.answer.ok ? `${view.answer.result.location?.shown ?? "no place shown"}; ${(view.answer.result.text.match(/\$\d[\d,.]*/g) ?? []).slice(0, 5).join(" ")}` : view.answer.error.message,
    });
  }

  if (want("shop")) {
    const { answer, ms } = await call("browser_shop", { query: "PS5 console", location: "Wisconsin", stores: ["amazon", "walmart", "target", "bestbuy", "costco"] });
    if (!answer.ok) record("browser_shop", false, { ms, note: answer.error.message });
    else {
      console.log(answer.summary);
      for (const store of answer.result.stores) {
        const priced = store.offers.filter((offer) => offer.price !== null);
        const file = answer.result.files.find((item) => store.screenshot && item.path.endsWith(store.screenshot));
        record(`shop: ${store.name}`, store.status === "ok" && priced.length > 0, {
          ms,
          status: store.status,
          mode: store.mode,
          shown: store.shown,
          screenshot: file?.path,
          offers: store.offers.map((offer) => `${offer.title} — ${offer.priceText || "not shown"}`),
          note: `${store.status}${store.mode === "clean" ? " (clean browser)" : ""}${store.shown ? `, ${store.shown}` : ""}${priced[0] ? `, ${priced[0].priceText} ${priced[0].title.slice(0, 60)}` : ""}${store.note ? ` — ${store.note}` : ""}`,
        });
      }
    }
  }

  if (want("charts")) {
    for (const [check, url, focus] of [
      ["Google Finance GOOG 5D chart", "https://www.google.com/finance/quote/GOOG:NASDAQ?window=5D", "price chart"],
      ["Yahoo Finance GOOG chart", "https://finance.yahoo.com/quote/GOOG/", "stock chart"],
    ]) {
      const { answer, ms } = await call("browser_view", { url, focus, name: check.replace(/\W+/g, "-").toLowerCase() });
      record(check, answer.ok && answer.result.focusFound === true, {
        ms,
        screenshot: answer.ok ? answer.result.file?.path : undefined,
        note: answer.ok ? `${answer.result.focusFound ? `captured ${answer.result.focusOn}` : "focus not found"} (${answer.result.file?.width}×${answer.result.file?.height}, ${answer.result.mode})` : answer.error.message,
      });
    }
  }

  if (want("pdf")) {
    const { answer, ms } = await call("browser_fetch", { url: PDF_URL });
    record("CVF paper fetched as a PDF", answer.ok && answer.result.mime === "application/pdf" && answer.result.size > 100_000, {
      ms,
      file: answer.ok ? answer.result.path : undefined,
      note: answer.ok ? `${answer.result.name}, ${(answer.result.size / 1024 / 1024).toFixed(1)} MB, ${answer.result.kind}` : answer.error.message,
    });
  }

  if (want("extract")) {
    const { answer, ms } = await call("browser_extract", { url: "https://en.wikipedia.org/wiki/PlayStation_5", focus: "specifications", maxChars: 4000 });
    record("A page read as Markdown", answer.ok && /\|.*\|/.test(answer.result.markdown), { ms, note: answer.ok ? `${answer.result.part}, ${answer.result.chars} characters, a table: ${/\|.*\|/.test(answer.result.markdown)}` : answer.error.message });
  }
} finally {
  await broker.shutdown();
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nReport: ${join(out, "report.json")}\nScreenshots and files: ${evidenceDir}`);
}
