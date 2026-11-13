export const DOCS_HOME = "https://docs.ensemblework.com/";

const normalize = (text) => text.normalize("NFKC").toLowerCase();

export function searchDocs(index, query, limit = 8) {
  const words = [...new Set(normalize(query).match(/[\p{L}\p{N}_]+/gu) ?? [])];
  if (!words.length || query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error("Use 1 to 200 characters of search words and a limit from 1 to 20.");
  }
  const matches = [];
  for (const page of index.pages) {
    const title = normalize(page.title);
    for (const section of page.sections) {
      const heading = normalize(section.heading);
      const text = normalize(section.text);
      if (!words.every((word) => `${title} ${heading} ${text}`.includes(word))) continue;
      const score = words.reduce((sum, word) => sum + (heading.includes(word) ? 12 : 0) + (title.includes(word) ? 8 : 0) + (text.includes(word) ? 1 : 0), 0);
      const positions = words.map((word) => text.indexOf(word)).filter((position) => position >= 0);
      const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 80);
      matches.push({ title: page.title, heading: section.heading, url: section.url, excerpt: section.text.slice(start, start + 400), score });
    }
  }
  matches.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  const results = matches.slice(0, limit).map(({ score, ...match }) => match);
  return {
    query,
    found: results.length > 0,
    home: DOCS_HOME,
    results,
    message: results.length ? "Matching published documentation." : `No published documentation matches these words. Open ${DOCS_HOME}`,
  };
}
