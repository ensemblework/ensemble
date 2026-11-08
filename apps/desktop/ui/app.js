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

function applyMotionTheme() {
  document.documentElement.setAttribute("data-motion-theme", "expressive");
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
  for (const id of ["welcome", "account", "signin"]) document.getElementById(id).hidden = true;
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
  for (const id of ["welcome", "account", "signin"]) document.getElementById(id).hidden = true;
  offline.hidden = true;
  loading.hidden = false;
  if (!window.EnsembleMorph) return;
  loader.__morph?.destroy();
  const morph = window.EnsembleMorph.mount(loader);
  loader.__morph = morph;
  morph.loop({ delay: loaderDelay() });
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

// ── First run, sign-in and the move to an account (docs/DESKTOP.md §1) ──────────

const screens = ["loading", "offline", "welcome", "account", "signin"].map((id) => document.getElementById(id));
let shell = null;
let polling = null;
let lastSignInUrl = "";
let finishing = false;

function show(id) {
  for (const screen of screens) screen.hidden = screen.id !== id;
  if (id !== "loading" && loader.__morph) loader.__morph.idle();
}

async function local(path, init) {
  if (!shell || !shell.apiBase) throw new Error("Ensemble's local service did not start. Quit and open Ensemble again; Export diagnostics in the Ensemble menu shows why.");
  const response = await fetch(shell.apiBase + path, {
    method: (init && init.method) || "GET",
    headers: { authorization: "Bearer " + shell.apiToken, "content-type": "application/json" },
    body: init && init.method === "POST" ? JSON.stringify(init.body || {}) : undefined,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(body.error || body.message || "Ensemble's local service did not answer.");
  return body;
}

const COUNT_NAMES = { tasks: ["task", "tasks"], task_pages: ["page", "pages"], projects: ["project", "projects"], people: ["person", "people"], context_documents: ["file", "files"], skills: ["skill", "skills"], page_boards: ["board", "boards"], block_diagrams: ["diagram", "diagrams"], plots: ["plot", "plots"], assistant_conversations: ["chat", "chats"], meeting_notes: ["meeting note", "meeting notes"] };

function describeCounts(counts) {
  if (!counts) return "";
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([table, n]) => `${n} ${(COUNT_NAMES[table] || [table, table])[n === 1 ? 0 : 1]}`);
  return parts.join(", ");
}

async function showWelcome() {
  show("welcome");
  const note = document.getElementById("welcome-note");
  const status = document.getElementById("welcome-status");
  note.textContent = "Choose once. Local-only can move to an account later; an account stays an account.";
  try {
    const account = await local("/api/desktop/account");
    const data = describeCounts(account.local);
    if (account.paired) note.textContent = "This computer is already connected to Ensemble (the CLI paired it). Sign in to open your account here; tasks keep running on this computer either way.";
    else if (data) note.textContent = `This computer already has Ensemble data: ${data}. With an account you can move it in; local-only keeps it here.`;
  } catch (error) {
    status.textContent = messageOf(error);
    status.classList.add("is-error");
  }
  document.getElementById("choose-account").focus();
}

async function showAccount() {
  show("account");
  const heading = document.getElementById("account-heading");
  const text = document.getElementById("account-text");
  const row = document.getElementById("move-row");
  const status = document.getElementById("account-status");
  status.textContent = "";
  status.classList.remove("is-error");
  let account;
  try {
    account = await local("/api/desktop/account");
  } catch (error) {
    status.textContent = messageOf(error);
    status.classList.add("is-error");
    return;
  }
  if (account.mode === null) return showWelcome();
  if (account.mode === "account") {
    heading.textContent = "Sign in to Ensemble";
    text.textContent = "Sign in with your browser to open your account in this window. Every sign-in method works there.";
    row.hidden = true;
  } else {
    heading.textContent = "Move to your Ensemble account";
    text.textContent = "Ensemble here then opens your account and stays in sync with the web app and your other devices. This happens once: the app does not go back to local-only.";
    const data = describeCounts(account.local);
    row.hidden = !data;
    document.getElementById("account-counts").textContent = data ? ` (${data}). Your account keeps its own version of anything it already has.` : "";
  }
  document.getElementById("account-start").focus();
}

function signInStatus(text, isError) {
  const status = document.getElementById("signin-status");
  status.textContent = text || "";
  status.classList.toggle("is-error", Boolean(isError));
}

async function startSignIn(move) {
  show("signin");
  document.getElementById("signin-heading").textContent = "Approve in your browser";
  document.getElementById("signin-code").textContent = "";
  document.getElementById("signin-progress").hidden = true;
  document.getElementById("signin-open").hidden = false;
  signInStatus("Starting the sign-in…");
  try {
    const account = await local("/api/desktop/account/sign-in", { method: "POST", body: { move } });
    await followSignIn(account.signIn);
  } catch (error) {
    signInStatus(messageOf(error), true);
  }
  clearInterval(polling);
  polling = setInterval(async () => {
    try {
      const account = await local("/api/desktop/account");
      await followSignIn(account.signIn);
    } catch (error) {
      signInStatus(messageOf(error), true);
    }
  }, 1500);
}

async function followSignIn(signIn) {
  if (!signIn) return;
  const progress = document.getElementById("signin-progress");
  if (signIn.state === "waiting") {
    if (signIn.userCode) document.getElementById("signin-code").textContent = signIn.userCode;
    if (signIn.url && signIn.url !== lastSignInUrl) {
      lastSignInUrl = signIn.url;
      invoke("open_sign_in", { url: signIn.url }).catch((error) => signInStatus(messageOf(error), true));
    }
    signInStatus("Waiting for you to approve in the browser…");
    return;
  }
  if (signIn.state === "moving") {
    document.getElementById("signin-heading").textContent = "Moving your data";
    document.getElementById("signin-code").textContent = "";
    document.getElementById("signin-open").hidden = true;
    progress.hidden = false;
    const sent = signIn.progress ? signIn.progress.sent : 0;
    signInStatus(sent ? `${sent} items moved so far. Keep Ensemble open.` : "Getting your data ready…");
    return;
  }
  if (signIn.state === "pairing") {
    progress.hidden = false;
    signInStatus("Connecting this computer for your tasks…");
    return;
  }
  if (signIn.state === "error") {
    clearInterval(polling);
    progress.hidden = true;
    signInStatus(signIn.error || "The sign-in did not finish.", true);
    document.getElementById("signin-cancel").textContent = "Back";
    return;
  }
  if (signIn.state === "idle") {
    clearInterval(polling);
    return;
  }
  if (signIn.state === "done" && !finishing) {
    finishing = true;
    clearInterval(polling);
    progress.hidden = true;
    document.getElementById("signin-heading").textContent = "You're signed in";
    const notes = signIn.notes || [];
    signInStatus(notes.length ? notes.join(" ") : "Opening your account…");
    if (notes.length) await new Promise((done) => setTimeout(done, 4000));
    try {
      const { url } = await local("/api/desktop/account/handoff", { method: "POST" });
      showLoading();
      await invoke("open_app", { url });
    } catch (error) {
      show("signin");
      signInStatus(messageOf(error), true);
    } finally {
      finishing = false;
    }
  }
}

document.getElementById("choose-account").addEventListener("click", () => startSignIn(true));
document.getElementById("choose-local").addEventListener("click", async (event) => {
  const status = document.getElementById("welcome-status");
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const account = await local("/api/desktop/account");
    if (account.paired && !window.confirm("Keeping Ensemble local only disconnects this computer from your Ensemble account, so tasks from the web stop running here. Continue?")) {
      button.disabled = false;
      return;
    }
    await local("/api/desktop/mode", { method: "POST", body: { mode: "local" } });
    showLoading();
    await invoke("open_local");
  } catch (error) {
    show("welcome");
    status.textContent = messageOf(error);
    status.classList.add("is-error");
    button.disabled = false;
  }
});
document.getElementById("account-start").addEventListener("click", () => startSignIn(document.getElementById("move-row").hidden ? false : document.getElementById("move").checked));
document.getElementById("account-back").addEventListener("click", () => leaveAccount());
document.getElementById("signin-open").addEventListener("click", () => {
  if (lastSignInUrl) invoke("open_sign_in", { url: lastSignInUrl }).catch((error) => signInStatus(messageOf(error), true));
});
document.getElementById("signin-cancel").addEventListener("click", async () => {
  clearInterval(polling);
  lastSignInUrl = "";
  document.getElementById("signin-cancel").textContent = "Cancel";
  await local("/api/desktop/account/cancel", { method: "POST" }).catch(() => undefined);
  leaveAccount();
});

async function leaveAccount() {
  let account = null;
  try {
    account = await local("/api/desktop/account");
  } catch (_) {
    account = null;
  }
  if (account && account.mode === "local") return invoke("open_local").catch((error) => showOffline(shell, messageOf(error)));
  if (account && account.mode === "account" && shell) return connect(shell.url, false);
  return showWelcome();
}

async function boot() {
  let state;
  try {
    state = await invoke("shell_state");
  } catch (error) {
    showOffline(null, messageOf(error));
    return;
  }
  shell = state;
  applyMotionTheme(state.motionTheme);
  if (state.hold || state.error) {
    showOffline(state, state.error || "");
    return;
  }
  input.value = state.url;
  showSource(state);
  const developerSite = state.source === "environment" || state.source === "build";
  if (!developerSite && location.hash === "#account") return showAccount();
  if (developerSite || state.mode === "account") return connect(state.url, false);
  if (state.mode === "local") return invoke("open_local").catch((error) => showOffline(state, messageOf(error)));
  return showWelcome();
}

boot();
