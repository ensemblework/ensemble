import { mountSearch } from "./site-search.js";
mountSearch();

const theme = document.querySelector("#theme-toggle");
function themeLabel() {
  const light = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "light" : matchMedia("(prefers-color-scheme: light)").matches;
  theme.dataset.nextTheme = light ? "dark" : "light";
  theme.setAttribute("aria-label", light ? "Switch to dark theme" : "Switch to light theme");
  theme.title = theme.getAttribute("aria-label");
  theme.querySelector('[data-theme-icon="sun"]').hidden = light;
  theme.querySelector('[data-theme-icon="moon"]').hidden = !light;
}
theme.hidden = false;
themeLabel();
matchMedia("(prefers-color-scheme: light)").addEventListener("change", themeLabel);
theme.addEventListener("click", () => {
  document.documentElement.dataset.theme = theme.dataset.nextTheme;
  try { localStorage.setItem("ensemble.docs.theme", document.documentElement.dataset.theme); } catch { /* Session-only when storage is blocked. */ }
  themeLabel();
});

const navigation = document.querySelector(".sidebar details");
const desktopLayout = matchMedia("(min-width: 761px)");
function sizeNavigation() { navigation.open = desktopLayout.matches; }
sizeNavigation();
desktopLayout.addEventListener("change", sizeNavigation);

function openLinkedTopic() {
  let id;
  try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
  const target = document.getElementById(id);
  if (target?.classList.contains("legacy-topic")) location.replace(target.querySelector("a").href);
}
openLinkedTopic();
window.addEventListener("hashchange", openLinkedTopic);
