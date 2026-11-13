import { searchDocs } from "./search.js";

const form = document.querySelector("#search-form");
const input = document.querySelector("#query");
const results = document.querySelector("#search-results");
let index;
let generation = 0;

async function search() {
  const current = ++generation;
  const query = input.value.trim();
  const url = new URL(location.href);
  if (query) url.searchParams.set("q", query);
  else url.searchParams.delete("q");
  history.replaceState(null, "", url);
  results.replaceChildren();
  results.hidden = !query;
  if (!query) return;
  results.textContent = "Loading documentation.";
  try {
    if (!index) {
      const response = await fetch("/search-index.json");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      index = await response.json();
    }
    if (current !== generation) return;
    const answer = searchDocs(index, query);
    results.replaceChildren();
    const status = document.createElement("p");
    status.textContent = answer.message;
    results.append(status);
    for (const hit of answer.results) {
      const item = document.createElement("div");
      const link = document.createElement("a");
      link.href = new URL(hit.url).pathname + new URL(hit.url).hash;
      link.textContent = `${hit.title}: ${hit.heading}`;
      const excerpt = document.createElement("p");
      excerpt.textContent = hit.excerpt;
      item.append(link, excerpt);
      results.append(item);
    }
  } catch (error) {
    if (current !== generation) return;
    console.error("Documentation search failed", error);
    results.textContent = "Documentation search could not load. Try again or use All guides.";
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void search();
});
input.value = new URL(location.href).searchParams.get("q") ?? "";
if (input.value) void search();
