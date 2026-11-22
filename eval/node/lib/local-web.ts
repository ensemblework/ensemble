/**
 * The Node website's origin for serve mode (serve.ts): on this computer and named `localhost`, because the
 * browser keeps one host-only session cookie for `localhost` across ports, so the website and the API
 * share it. A hosted site (node.ensemblework.com, node-test.ensemblework.com) is never served.
 */
export function localWebOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`--web takes the website's origin, such as http://localhost:3300 (got "${value}").`);
  }
  if (url.protocol !== "http:" || url.hostname !== "localhost" || !url.port || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error(`Serve mode answers only a website on this computer at http://localhost:<port> (got "${value}").`);
  }
  return url.origin;
}
