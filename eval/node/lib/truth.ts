/**
 * Live ground truth, fetched when a task is graded and cached for the rest of the run (one fetch
 * per address), so every repeat and the regrade of a run compare against the same answer.
 */
const cache = new Map<string, Promise<unknown>>();

export async function getJson(url: string): Promise<unknown> {
  const known = cache.get(url);
  if (known) return known;
  const pending = fetch(url, { headers: { "user-agent": "ensemble-node-eval", accept: "application/json" }, signal: AbortSignal.timeout(20_000) }).then(async (response) => {
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response.json() as Promise<unknown>;
  });
  cache.set(url, pending);
  pending.catch(() => cache.delete(url));
  return pending;
}

export type Cycle = { cycle: string; lts?: string | boolean; latest?: string; eol?: string | boolean; releaseDate?: string; latestReleaseDate?: string; support?: string | boolean };

/** endoflife.date's release cycles of a product, newest first. */
export async function cycles(product: string): Promise<Cycle[]> {
  return (await getJson(`https://endoflife.date/api/${product}.json`)) as Cycle[];
}

/** The newest Node.js LTS line that has started its LTS phase. */
export async function nodeLts(today = new Date().toISOString().slice(0, 10)): Promise<{ major: string; latest: string; eol: string; ltsFrom: string }> {
  const rows = await cycles("nodejs");
  const lts = rows.find((row) => typeof row.lts === "string" && row.lts <= today) ?? rows.find((row) => row.lts);
  if (!lts) throw new Error("endoflife.date lists no Node.js LTS line");
  return { major: lts.cycle, latest: String(lts.latest ?? ""), eol: String(lts.eol ?? ""), ltsFrom: String(lts.lts) };
}
