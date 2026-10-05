const invoke = window.__TAURI__.core.invoke;
const status = document.querySelector("#status");
const tokenForm = document.querySelector("#token-form");
const captureForm = document.querySelector("#capture-form");

function setStatus(message) {
  status.textContent = message;
}

async function refresh() {
  const current = await invoke("capture_status");
  document.querySelector("#chord").textContent = current.chord;
  document.querySelector("#api").value = current.api;
  tokenForm.hidden = current.hasToken;
  captureForm.hidden = !current.hasToken;
  if (current.hasToken) document.querySelector("#text").focus();
  else document.querySelector("#token").focus();
}

tokenForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("");
  try {
    await invoke("save_token", {
      api: document.querySelector("#api").value,
      token: document.querySelector("#token").value,
    });
    await refresh();
  } catch (error) {
    setStatus(String(error));
  }
});

captureForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = document.querySelector("#text").value.trim();
  if (!text) return;
  setStatus("Saving…");
  try {
    const saved = await invoke("submit_capture", { text });
    const people = saved.people.length ? ` · ${saved.people.join(", ")}` : "";
    const due = saved.dueLabel ? ` · due ${saved.dueLabel}` : "";
    setStatus(`Saved “${saved.title}”${people}${due}`);
    document.querySelector("#text").value = "";
    window.setTimeout(() => invoke("hide_capture"), 700);
  } catch (error) {
    setStatus(String(error));
  }
});

document.querySelector("#cancel").addEventListener("click", () => invoke("hide_capture"));
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") invoke("hide_capture");
});

refresh().catch((error) => setStatus(String(error)));
