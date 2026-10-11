#!/usr/bin/env node
// Tells IndexNow search engines that the published landing pages changed: Bing
// (which also feeds DuckDuckGo, Yahoo and Ecosia), Yandex, Seznam and Naver.
// Google does not read IndexNow; it finds pages through the sitemap and Search Console.
// deploy.yml runs this after the landing page is published. It reads the live
// sitemap, so it submits exactly what visitors can open.
import { readFileSync } from "node:fs";

const SITE = "https://ensemblework.com";
// Not a secret: the protocol proves ownership by serving this value at /<key>.txt
// (apps/landing/public). Change both together.
const KEY = "969fd16ed6931f727732aec2e79b1434";
const KEY_URL = `${SITE}/${KEY}.txt`;

const local = readFileSync(new URL(`../public/${KEY}.txt`, import.meta.url), "utf8").trim();
if (local !== KEY) throw new Error(`apps/landing/public/${KEY}.txt does not contain the key`);

async function text(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
}

// IndexNow fetches the key file before it accepts the list.
if ((await text(KEY_URL)).trim() !== KEY) throw new Error(`${KEY_URL} does not serve the key yet`);

const urls = [...(await text(`${SITE}/sitemap.xml`)).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
if (urls.length === 0) throw new Error("The live sitemap lists no pages");

const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host: new URL(SITE).host, key: KEY, keyLocation: KEY_URL, urlList: urls }),
  signal: AbortSignal.timeout(15_000),
});
// 200 and 202 both mean accepted; 202 means the key is still being checked.
if (res.status !== 200 && res.status !== 202) {
  throw new Error(`IndexNow answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
console.log(`IndexNow accepted ${urls.length} URLs (${res.status}).`);
