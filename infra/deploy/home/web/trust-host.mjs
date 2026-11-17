/**
 * Next 15's standalone server builds middleware redirects from its bind hostname.
 * A tunnel would send the browser to https://localhost:3000. The public config
 * schema also drops trustHostHeader. This patch is applied only to the standalone
 * output. Vercel does not run this file.
 *
 * An empty hostname is required: the render worker treats undefined as localhost,
 * and any other hostname is used in the redirect instead of the Host header.
 * Listening with an empty hostname binds every interface. Nothing forwards the port.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("usage: trust-host.mjs <standalone server.js>");
  process.exit(1);
}

const bindFrom = "const hostname = process.env.HOSTNAME || '0.0.0.0'";
const bindTo = "const hostname = process.env.ENSEMBLE_PUBLIC_HOST === '1' ? '' : (process.env.HOSTNAME || '0.0.0.0')";
let source = readFileSync(file, "utf8");
if (!source.includes(bindTo)) {
  if (!source.includes(bindFrom) || (source.match(/"trustHostHeader":false/g) ?? []).length !== 1) {
    console.error(`standalone server.js is not the expected Next 15 shape (${file})`);
    process.exit(1);
  }
  source = source.replace('"trustHostHeader":false', '"trustHostHeader":true').replace(bindFrom, bindTo);
  writeFileSync(file, source);
}

const workerFrom = "hostname: opts.hostname || 'localhost'";
const workerTo = "hostname: opts.hostname === '' ? '' : (opts.hostname || 'localhost')";
const root = join(dirname(file), "../../..");
const workers = [];
const walk = (dir) => {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === ".git") continue;
    const path = join(dir, name.name);
    if (name.isDirectory()) walk(path);
    else if (name.name === "render-server.js") workers.push(path);
  }
};
walk(root);
if (workers.length !== 1) {
  console.error(`expected one render-server.js under ${root}, found ${workers.length}`);
  process.exit(1);
}
const workerPath = workers[0];
const worker = readFileSync(workerPath, "utf8");
if (!worker.includes(workerTo)) {
  if (!worker.includes(workerFrom)) {
    console.error(`render worker is not the expected Next 15 shape (${workerPath})`);
    process.exit(1);
  }
  writeFileSync(workerPath, worker.replace(workerFrom, workerTo));
}
console.log(`public host redirects enabled in ${file}`);
