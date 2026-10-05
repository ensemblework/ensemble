const loading = document.querySelector("#loading");
const offline = document.querySelector("#offline");
const heading = document.querySelector("#heading");
const eyebrow = document.querySelector("#eyebrow");
const message = document.querySelector("#message");
const status = document.querySelector("#status");
const form = document.querySelector("#server-form");
const input = document.querySelector("#url");
const sourceNote = document.querySelector("#source");
const button = document.querySelector("#connect");
const loader = document.querySelector("#loader");

const THEMES = { expressive: true, "minimal-quiet": true, "minimal-dot": true };

function invoke(command, args) {
  const call = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  if (!call) return Promise.reject(new Error("The desktop shell is not ready."));
  return call(command, args);
}

function messageOf(error) {
  if (typeof error === "string") return error;
  if (error && typeof error.message === "string") return error.message;
  return "Could not reach Ensemble.";
}

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function applyMotionTheme(theme) {
  if (THEMES[theme]) document.documentElement.setAttribute("data-motion-theme", theme);
  else document.documentElement.removeAttribute("data-motion-theme");
}

function showSource(state) {
  if (state.source === "environment") {
    sourceNote.textContent = "This run uses ENSEMBLE_SITE_URL. A URL you save is kept for the next launch without that variable.";
    return;
  }
  if (state.source === "saved") {
    sourceNote.textContent = "Saved on this computer.";
    return;
  }
  if (state.source === "build") {
    sourceNote.textContent = "Set when this app was built.";
    return;
  }
  sourceNote.textContent = "Local dev uses http://localhost:3000.";
}

function setStatus(text, isError) {
  status.textContent = text || "";
  status.classList.toggle("is-error", Boolean(isError));
}

function showOffline(state, errorText) {
  if (loader.__morph) loader.__morph.idle();
  loading.hidden = true;
  offline.hidden = false;
  applyMotionTheme(state && state.motionTheme);
  input.value = state && state.url ? state.url : input.value;
  if (state) showSource(state);
  const failed = Boolean(errorText);
  eyebrow.textContent = failed ? "offline" : "server";
  heading.textContent = failed ? "You’re offline." : "Server URL";
  message.textContent = failed
    ? "This app could not reach the Ensemble server. Check the address, then try again."
    : "This window opens one Ensemble server. Links to other sites open in your browser.";
  setStatus(failed ? errorText : "", failed);
  button.disabled = false;
  button.textContent = failed ? "Try again" : "Connect";
  input.focus();
}

function loaderDelay() {
  const delay = Number(loader.dataset.delay);
  return Number.isFinite(delay) ? delay : 0;
}

function showLoading() {
  offline.hidden = true;
  loading.hidden = false;
  if (!window.EnsembleMorph) return;
  const morph = window.EnsembleMorph.mount(loader);
  if (reducedMotion()) {
    loader.classList.add("is-held");
    window.setTimeout(() => {
      if (loading.hidden) return;
      loader.classList.remove("is-held");
      loader.removeAttribute("data-loader");
      morph.idle();
    }, loaderDelay());
    return;
  }
  loader.classList.remove("is-held");
  if (!loader.hasAttribute("data-loader")) loader.setAttribute("data-loader", "");
  morph.loop();
}

async function connect(url, save) {
  button.disabled = true;
  showLoading();
  try {
    await invoke("connect_to", { url, save });
  } catch (error) {
    let state = null;
    try {
      state = await invoke("shell_state");
    } catch (_) {
      state = null;
    }
    const next = state || { url, source: "saved" };
    showOffline({ ...next, url }, messageOf(error));
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  connect(input.value, true);
});

async function boot() {
  let state;
  try {
    state = await invoke("shell_state");
  } catch (error) {
    showOffline(null, messageOf(error));
    return;
  }
  applyMotionTheme(state.motionTheme);
  if (state.hold || state.error) {
    showOffline(state, state.error || "");
    return;
  }
  input.value = state.url;
  showSource(state);
  connect(state.url, false);
}

boot();
