import { mount, staticSVG } from '@ensemble/brand/motion';
import { helperLayout } from './helper-layout.js';

const launcher = document.querySelector('#docs-launcher');
const panel = document.querySelector('#docs-helper');
const form = document.querySelector('#helper-form');
const question = document.querySelector('#helper-question');
const conversation = document.querySelector('#helper-conversation');
const turnsElement = document.querySelector('#helper-turns');
const welcome = document.querySelector('#helper-welcome');
const waiting = document.querySelector('#helper-waiting');
const notice = document.querySelector('#helper-notice');
const submit = document.querySelector('#helper-submit');
const login = document.querySelector('#helper-login');
const topLogin = document.querySelector('#docs-login');
const logout = document.querySelector('#helper-logout');
const earlier = document.querySelector('#helper-earlier');
const accountLabel = document.querySelector('#helper-account');
const clearConfirm = document.querySelector('#helper-clear-confirm');
const apiBase = new URL(panel.dataset.endpoint).origin;
const mark = mount(launcher.querySelector('.u-morph'), { size: 32, kind: 'beacon' });
const waitMark = mount(waiting.querySelector('.u-morph'), { size: 64, kind: 'infinity' });
let account = null, checked = false, pending = null, turns = [], before = null, sessionRequest = 0, elapsed;
let sync;
let active = true;

function open() {
  panel.hidden = false;
  launcher.hidden = true;
  launcher.setAttribute('aria-expanded', 'true');
  document.documentElement.dataset.assistantOpen = 'true';
  sync();
  question.focus();
  if (checked) refreshSession();
}
function dismiss() {
  panel.hidden = true;
  launcher.hidden = false;
  launcher.setAttribute('aria-expanded', 'false');
  delete document.documentElement.dataset.assistantOpen;
  sync();
  launcher.focus();
}
sync = helperLayout(launcher, panel, open);
launcher.hidden = false;
document.querySelector('#helper-close').addEventListener('click', dismiss);
panel.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); dismiss(); } });

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}/api/docs/${path}`, { credentials: 'include', signal: AbortSignal.timeout(10_000), ...options, headers: { ...(account ? { 'x-ensemble-docs-account': account.id } : {}), ...options.headers } });
  const result = response.status === 204 ? null : await response.json().catch(() => ({ error: "The docs helper is unavailable. Try again shortly." }));
  if (!response.ok) throw Object.assign(new Error(result?.error || 'The docs helper could not answer. Try again or use search.'), { status: response.status });
  return result;
}
function showNotice(text = '') { notice.textContent = text; notice.hidden = !text; }
function render() {
  turnsElement.replaceChildren();
  welcome.hidden = turns.length > 0 || Boolean(pending);
  for (const turn of turns) {
    const section = document.createElement('section');
    section.className = 'assistant-turn';
    const user = document.createElement('div'); user.className = 'assistant-user-turn';
    const bubble = document.createElement('div'); bubble.className = 'assistant-user-message'; bubble.textContent = turn.question;
    user.append(bubble); section.append(user);
    if (turn.answer) {
      const heading = document.createElement('div'); heading.className = 'assistant-message-heading';
      const avatar = document.createElement('span'); avatar.className = 'assistant-message-avatar'; avatar.innerHTML = staticSVG(18, { id: `turn-${turn.id}`, tone: 'auto' });
      const label = document.createElement('span'); label.textContent = 'Ensemble docs';
      heading.append(avatar, label);
      const body = document.createElement('div'); body.className = 'assistant-answer-body'; body.textContent = turn.answer;
      const sources = document.createElement('div'); sources.className = 'helper-sources';
      for (const source of turn.sources ?? []) {
        const url = new URL(source.url);
        if (url.origin !== 'https://docs.ensemblework.com') continue;
        const link = document.createElement('a'); link.href = url.href; link.textContent = source.title; sources.append(link);
      }
      section.append(heading, body, sources);
    }
    turnsElement.append(section);
  }
  earlier.hidden = !account || !before;
  updateControls();
}
function updateControls() {
  submit.disabled = !checked || (!pending && !question.value.trim());
  submit.dataset.pending = String(Boolean(pending));
  submit.setAttribute('aria-label', pending ? 'Stop answering' : 'Send question');
}
function updateAccount() {
  login.hidden = Boolean(account);
  logout.hidden = !account;
  accountLabel.textContent = account ? `Saved for ${account.name || 'your account'}` : 'Guest chat. History is not saved.';
  topLogin.textContent = account ? account.name || 'Your docs chat' : 'Sign in';
  topLogin.dataset.signedIn = String(Boolean(account));
}
async function loadHistory(older = false) {
  if (!account) return;
  const owner = account.id;
  const data = await request(`history${older && before ? `?before=${encodeURIComponent(before)}` : ''}`);
  if (account?.id !== owner) return;
  const oldHeight = conversation.scrollHeight;
  turns = older ? [...data.turns, ...turns] : data.turns;
  before = data.before;
  render();
  conversation.scrollTop = older ? conversation.scrollHeight - oldHeight : conversation.scrollHeight;
}
async function refreshSession() {
  const version = ++sessionRequest;
  if (account) { turnsElement.style.visibility = "hidden"; accountLabel.textContent = "Checking sign-in…"; }
  try {
    const data = await request('session');
    if (version !== sessionRequest) return;
    const changed = account?.id !== data.user?.id;
    if (changed) { pending?.abort(); turns = []; before = null; question.value = ""; }
    account = data.user;
    const url = new URL(data.loginUrl);
    if (['http:', 'https:'].includes(url.protocol)) login.href = topLogin.href = url.href;
    checked = true;
    turnsElement.style.visibility = "";
    updateAccount();
    if (account && (changed || !turns.length) && !pending) await loadHistory();
    render();
  } catch {
    if (version !== sessionRequest) return;
    if (!checked) { checked = true; account = null; updateAccount(); render(); }
    showNotice('Sign-in status could not load. You can ask as a guest, or reload to check your sign-in.');
  }
}
topLogin.addEventListener('click', (event) => { if (account) { event.preventDefault(); open(); } });
earlier.addEventListener('click', () => loadHistory(true).catch(error => showNotice(error.message)));
document.querySelector('#helper-history').addEventListener('click', () => {
  if (!account) { showNotice('Sign in to keep your docs-chat history.'); return; }
  if (before) loadHistory(true).catch(error => showNotice(error.message));
  else conversation.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
});
logout.addEventListener('click', async () => {
  pending?.abort();
  try {
    await request('logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    account = null; turns = []; before = null; question.value = ""; updateAccount(); render(); showNotice();
  } catch (error) { showNotice(error.message); }
});
document.querySelector('#helper-clear').addEventListener('click', () => { clearConfirm.hidden = false; });
document.querySelector('#helper-keep').addEventListener('click', () => { clearConfirm.hidden = true; });
document.querySelector('#helper-delete').addEventListener('click', async () => {
  pending?.abort();
  try {
    if (account) await request('history', { method: 'DELETE' });
    turns = []; before = null; question.value = ""; clearConfirm.hidden = true; render(); showNotice();
  } catch (error) { showNotice(error.message); }
});
question.addEventListener('input', () => {
  question.style.height = 'auto'; question.style.height = `${Math.min(160, question.scrollHeight)}px`; updateControls();
});
question.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
for (const starter of document.querySelectorAll('[data-docs-question]')) starter.addEventListener('click', () => { question.value = starter.dataset.docsQuestion; form.requestSubmit(); });
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (pending) { pending.abort(); return; }
  const text = question.value.trim();
  if (!text || !checked) return;
  const owner = account?.id ?? null;
  const controller = new AbortController(); pending = controller;
  let recheck = false;
  const draft = { id: crypto.randomUUID(), question: text, answer: '', sources: [] };
  turns.push(draft); question.value = ''; question.style.height = '';
  showNotice(); waiting.hidden = false; waiting.setAttribute('aria-busy', 'true');
  waitMark.loop({ delay: 350, kind: 'infinity' }); mark.loop({ delay: 350, kind: 'beacon' });
  const since = Date.now();
  elapsed = setInterval(() => { const seconds = Math.floor((Date.now() - since) / 1000); document.querySelector('#helper-elapsed').textContent = seconds >= 10 ? `${seconds}s elapsed` : ''; }, 1000);
  render(); conversation.scrollTop = conversation.scrollHeight;
  try {
    const result = await request('ask', { method: 'POST', credentials: owner ? 'include' : 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: text, ...(owner ? { remember: true } : {}) }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(65_000)]) });
    if (controller.signal.aborted || (account?.id ?? null) !== owner) return;
    Object.assign(draft, result.turn ?? result);
    if (owner && !result.saved) showNotice('History changed while this answer was running. This answer was not saved.');
  } catch (error) {
    if (!active || (account?.id ?? null) !== owner) return;
    turns = turns.filter(turn => turn !== draft);
    question.value = text;
    if (!controller.signal.aborted) showNotice(error.message);
    if (error.status === 401 || error.status === 409) { account = null; turns = []; before = null; question.value = ""; recheck = true; updateAccount(); }
  } finally {
    if (pending === controller) pending = null;
    clearInterval(elapsed); waiting.hidden = true; waiting.removeAttribute('aria-busy');
    waitMark.idle(); mark.idle(); render(); conversation.scrollTop = conversation.scrollHeight;
    if (recheck) await refreshSession();
  }
});
addEventListener('focus', () => { if (!pending) refreshSession(); });
addEventListener('pagehide', () => { active = false; pending?.abort(); question.value = ''; turns = []; turnsElement.replaceChildren(); waitMark.idle(); mark.idle(); clearInterval(elapsed); });
addEventListener('pageshow', event => { active = true; if (event.persisted) refreshSession(); sync(); });
refreshSession();
if (location.hash === '#docs-chat') open();
