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

const theme = document.querySelector("#theme-toggle");
function themeLabel() {
  const light = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "light" : matchMedia("(prefers-color-scheme: light)").matches;
  theme.textContent = light ? "Dark theme" : "Light theme";
}
theme.hidden = false;
themeLabel();
matchMedia("(prefers-color-scheme: light)").addEventListener("change", themeLabel);
theme.addEventListener("click", () => {
  document.documentElement.dataset.theme = theme.textContent === "Dark theme" ? "dark" : "light";
  try { localStorage.setItem("ensemble.docs.theme", document.documentElement.dataset.theme); } catch { /* Session-only when storage is blocked. */ }
  themeLabel();
});

const navigation = document.querySelector(".sidebar details");
const desktopLayout = matchMedia("(min-width: 761px)");
function sizeNavigation() { navigation.open = desktopLayout.matches; }
sizeNavigation();
desktopLayout.addEventListener("change", sizeNavigation);
