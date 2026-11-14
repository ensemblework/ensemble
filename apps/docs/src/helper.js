import { mount } from "@ensemble/brand/motion";

const launcher = document.querySelector("#docs-launcher");
const panel = document.querySelector("#docs-helper");
const close = document.querySelector("#helper-close");
const form = document.querySelector("#helper-form");
const question = document.querySelector("#helper-question");
const answer = document.querySelector("#helper-answer");
const submit = form.querySelector("button");
const mark = mount(launcher.querySelector(".u-morph"), { size: 32, kind: "beacon" });
let pending;
launcher.hidden = false;
launcher.addEventListener("click", () => {
  panel.hidden = false;
  launcher.hidden = true;
  launcher.setAttribute("aria-expanded", "true");
  question.focus();
});
function dismiss() {
  pending?.abort();
  panel.hidden = true;
  launcher.hidden = false;
  launcher.setAttribute("aria-expanded", "false");
  launcher.focus();
}
close.addEventListener("click", dismiss);
panel.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { event.preventDefault(); dismiss(); }
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = question.value.trim();
  if (!text || pending) return;
  const controller = new AbortController();
  pending = controller;
  submit.disabled = true;
  answer.textContent = "Looking in the docs…";
  answer.setAttribute("aria-busy", "true");
  mark.loop({ delay: 350, kind: "beacon" });
  try {
    const response = await fetch(panel.dataset.endpoint, {
      method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: text }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(65_000)]),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "The docs helper could not answer. Try again or use search.");
    answer.replaceChildren();
    const paragraph = document.createElement("p");
    paragraph.textContent = result.answer;
    answer.append(paragraph);
    const sources = document.createElement("ul");
    for (const source of result.sources ?? []) {
      const url = new URL(source.url);
      if (url.origin !== "https://docs.ensemblework.com") continue;
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = url.href;
      link.textContent = source.title;
      item.append(link);
      sources.append(item);
    }
    answer.append(sources);
  } catch (error) {
    answer.textContent = controller.signal.aborted ? "Ask a question about Ensemble." : error.message || "The docs helper could not answer. Try again or use search.";
  } finally {
    pending = undefined;
    submit.disabled = false;
    answer.removeAttribute("aria-busy");
    mark.idle();
  }
});
window.addEventListener("pagehide", () => { pending?.abort(); mark.destroy(); }, { once: true });
