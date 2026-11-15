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
const historyPanel = document.querySelector('#helper-history-panel');
const chatList = document.querySelector('#helper-chat-list');
const moreChats = document.querySelector('#helper-more-chats');
let chatId = null, chatsBefore = null, chatsFlight = null;
const authRecovery = document.querySelector('#helper-auth-recovery');
const apiBase = new URL(panel.dataset.endpoint).origin;
const mark = mount(launcher.querySelector('.u-morph'), { size: 32, kind: 'beacon' });
const waitMark = mount(waiting.querySelector('.u-morph'), { size: 64, kind: 'infinity' });
let account = null, checked = false, pending = null, turns = [], before = null, sessionRequest = 0;
let epoch = 0, historyFlight = null, mutating = false, deferredSession = false, authError = false, guestMode = false;
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
  welcome.hidden = turns.length > 0 || Boolean(pending) || !checked;
  const visible = checked ? turns : [];
  for (const turn of visible) {
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
  question.readOnly = !checked || mutating;
  question.style.visibility = checked ? "" : "hidden";
  submit.disabled = !pending && (!checked || mutating || Boolean(historyFlight) || !question.value.trim());
  earlier.disabled = !checked || Boolean(historyFlight) || Boolean(pending);
  document.querySelector('#helper-new').disabled = !checked || mutating;
  document.querySelector('#helper-history').disabled = !checked || Boolean(historyFlight) || Boolean(pending);
  document.querySelector('#helper-clear').disabled = !checked || mutating;
  logout.disabled = !checked || mutating;
  authRecovery.hidden = !authError;
  submit.dataset.pending = String(Boolean(pending));
  submit.setAttribute('aria-label', pending ? 'Stop answering' : 'Send question');
}
function updateAccount() {
  login.hidden = Boolean(account) && checked;
  logout.hidden = !account || !checked;
  accountLabel.textContent = !checked ? authError ? 'Sign-in unavailable.' : 'Checking sign-in…' : account ? `Saved for ${account.name || 'your account'}` : 'Guest chat. History is not saved.';
  topLogin.textContent = account && checked ? account.name || 'Your docs chat' : 'Sign in';
  topLogin.dataset.signedIn = String(Boolean(account && checked));
}
function finishWaiting(operation) {
  clearInterval(operation?.timer);
  waiting.hidden = true; waiting.removeAttribute('aria-busy');
  waitMark.idle(); mark.idle();
}
function invalidate(invalidateSession = true) {
  epoch++; chatsFlight = null; closeHistory(); chatList.replaceChildren(); if (invalidateSession) sessionRequest++; historyFlight = null; mutating = false; deferredSession = false;
  if (pending) { const operation = pending; pending = null; operation.controller.abort(); finishWaiting(operation); }
}
function emptyConversation() { chatId = null; chatsBefore = null; chatList.replaceChildren(); closeHistory(); turns = []; before = null; question.value = ''; question.style.height = ''; }
async function loadHistory(older = false) {
  if (!account) return;
  if (historyFlight) return historyFlight.promise;
  const flight = { owner: account.id, epoch, promise: null };
  historyFlight = flight;
  updateControls();
  flight.promise = (async () => {
    try {
      const params = new URLSearchParams();
      if (chatId) params.set('chatId', chatId);
      if (older && before) params.set('before', before);
      const data = await request(`history${params.size ? `?${params}` : ''}`);
      if (!active || historyFlight !== flight || epoch !== flight.epoch || account?.id !== flight.owner) return;
      chatId = data.chatId ?? chatId;
      const oldHeight = conversation.scrollHeight;
      const merged = older ? [...data.turns, ...turns] : data.turns;
      const seen = new Set();
      turns = merged.filter(turn => !seen.has(turn.id) && seen.add(turn.id));
      before = data.before;
      render();
      conversation.scrollTop = older ? conversation.scrollHeight - oldHeight : conversation.scrollHeight;
      return true;
    } finally {
      if (historyFlight === flight) { historyFlight = null; updateControls(); }
    }
  })();
  return flight.promise;
}
async function refreshSession() {
  if (guestMode) return;
  if (mutating) { deferredSession = true; return; }
  const version = ++sessionRequest;
  checked = false; authError = false; if (!historyPanel.hidden) { chatList.replaceChildren(); closeHistory(); chatsFlight = null; } updateAccount(); render();
  try {
    const data = await request('session');
    if (!active || version !== sessionRequest) return;
    const changed = account?.id !== data.user?.id;
    if (changed) {
      // Invalidate conversation work without invalidating this accepted session response.
      invalidate(false);
      emptyConversation();
    }
    account = data.user;
    const url = new URL(data.loginUrl);
    if (['http:', 'https:'].includes(url.protocol)) login.href = topLogin.href = url.href;
    if (account && (changed || !turns.length) && !pending) await loadHistory();
    if (!active || version !== sessionRequest) return;
    checked = true; authError = false; updateAccount(); render();
    if (notice.dataset.authError) { showNotice(); delete notice.dataset.authError; }
  } catch {
    if (!active || version !== sessionRequest) return;
    checked = false; authError = true; updateAccount(); render();
    notice.dataset.authError = 'true';
    showNotice('Sign-in could not be checked. Retry to restore your history, or continue as a guest.');
  }
}
document.querySelector('#helper-retry-session').addEventListener('click', () => refreshSession());
document.querySelector('#helper-guest').addEventListener('click', () => {
  invalidate(); emptyConversation(); account = null; checked = true; authError = false; guestMode = true;
  updateAccount(); render(); showNotice();
});
topLogin.addEventListener('click', (event) => { if (account && checked) { event.preventDefault(); open(); } });
earlier.addEventListener('click', () => { if (checked && !pending) loadHistory(true).catch(error => showNotice(error.message)); });
function closeHistory() {
  chatsFlight = null;
  historyPanel.hidden = true; conversation.hidden = false;
  document.querySelector('.assistant-composer-area').hidden = false;
  document.querySelector('#helper-history').setAttribute('aria-expanded', 'false');
}
async function showChats(older = false) {
  if (!checked || pending || chatsFlight) return;
  historyPanel.hidden = false; conversation.hidden = true;
  document.querySelector('.assistant-composer-area').hidden = true;
  document.querySelector('#helper-history').setAttribute('aria-expanded', 'true');
  if (!account) { chatList.textContent = 'Guest chats are not saved. Sign in to reopen earlier conversations.'; moreChats.hidden = true; return; }
  const flight = { epoch, owner: account.id }; chatsFlight = flight;
  moreChats.disabled = true;
  if (!older) chatList.textContent = 'Loading your chats…';
  try {
    const data = await request(`chats${older && chatsBefore ? `?before=${encodeURIComponent(chatsBefore)}` : ''}`);
    if (epoch !== flight.epoch || account?.id !== flight.owner || chatsFlight !== flight || historyPanel.hidden) return;
    if (!older) chatList.replaceChildren();
    if (!data.chats.length && !older) chatList.textContent = 'Your saved chats will appear here after your first question.';
    for (const chat of data.chats) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'helper-chat-item';
      const title = document.createElement('strong'); title.textContent = chat.title;
      const date = document.createElement('span'); date.textContent = new Date(chat.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      button.append(title, date);
      if (chat.id === chatId) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', async () => {
        if (!checked || pending) return;
        invalidate(); emptyConversation(); chatId = chat.id;
        const selected = epoch; showNotice('Loading chat…'); render();
        try { await loadHistory(); if (selected === epoch) { showNotice(); question.focus(); } }
        catch (error) { if (selected === epoch) showNotice(error.message); }
      });
      chatList.append(button);
    }
    chatsBefore = data.before; moreChats.hidden = !chatsBefore;
  } catch (error) { if (epoch === flight.epoch && account?.id === flight.owner) chatList.textContent = `${error.message} Close History and try again.`; }
  finally { if (chatsFlight === flight) { chatsFlight = null; moreChats.disabled = false; } }
}
document.querySelector('#helper-history').addEventListener('click', () => { if (historyPanel.hidden) showChats(); else closeHistory(); });
document.querySelector('#helper-history-close').addEventListener('click', () => { chatsFlight = null; closeHistory(); question.focus(); });
moreChats.addEventListener('click', () => showChats(true));
document.querySelector('#helper-new').addEventListener('click', () => {
  if (!checked || mutating) return;
  invalidate(); emptyConversation(); chatId = crypto.randomUUID(); showNotice(); render(); question.focus();
});
async function changeHistory(action) {
  if (!checked || mutating) return;
  invalidate(); const version = epoch; mutating = true; checked = false;
  updateAccount(); render();
  let failure;
  try {
    if (action === 'logout') await request('logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    else if (account) await request('history', { method: 'DELETE' });
    if (version !== epoch || !active) return;
    emptyConversation();
    if (action === 'logout') account = null;
    clearConfirm.hidden = true; showNotice();
  } catch (error) { failure = error; }
  finally {
    if (version === epoch && active) {
      mutating = false;
      if (deferredSession || failure) { deferredSession = false; await refreshSession(); }
      else { checked = true; updateAccount(); render(); }
      if (failure) showNotice(failure.message);
    }
  }
}
logout.addEventListener('click', () => changeHistory('logout'));
document.querySelector('#helper-clear').addEventListener('click', () => { if (checked) clearConfirm.hidden = false; });
document.querySelector('#helper-keep').addEventListener('click', () => { clearConfirm.hidden = true; });
document.querySelector('#helper-delete').addEventListener('click', () => changeHistory('clear'));
question.addEventListener('input', () => {
  question.style.height = 'auto'; question.style.height = `${Math.min(160, question.scrollHeight)}px`; updateControls();
});
question.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
for (const starter of document.querySelectorAll('[data-docs-question]')) starter.addEventListener('click', () => { question.value = starter.dataset.docsQuestion; form.requestSubmit(); });
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (pending) { pending.controller.abort(); return; }
  const text = question.value.trim();
  if (!text || !checked || historyFlight || mutating) return;
  const operation = { controller: new AbortController(), owner: account?.id ?? null, epoch, timer: null };
  pending = operation;
  let recheck = false;
  const draft = { id: crypto.randomUUID(), question: text, answer: '', sources: [] };
  const current = () => active && pending === operation && epoch === operation.epoch && (account?.id ?? null) === operation.owner;
  turns.push(draft); question.value = ''; question.style.height = '';
  showNotice(); waiting.hidden = false; waiting.setAttribute('aria-busy', 'true');
  waitMark.loop({ delay: 350, kind: 'infinity' }); mark.loop({ delay: 350, kind: 'beacon' });
  const since = Date.now();
  operation.timer = setInterval(() => { const seconds = Math.floor((Date.now() - since) / 1000); document.querySelector('#helper-elapsed').textContent = seconds >= 10 ? `${seconds}s elapsed` : ''; }, 1000);
  render(); conversation.scrollTop = conversation.scrollHeight;
  try {
    const result = await request('ask', { method: 'POST', credentials: operation.owner ? 'include' : 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: text, ...(operation.owner ? { remember: true, ...(chatId ? { chatId } : {}) } : {}) }), signal: AbortSignal.any([operation.controller.signal, AbortSignal.timeout(65_000)]) });
    if (!current() || operation.controller.signal.aborted) return;
    if (operation.owner && !result.saved) {
      emptyConversation(); recheck = true;
      showNotice('History changed while this answer was running. This answer was not saved.');
    } else Object.assign(draft, result.turn ?? result);
  } catch (error) {
    if (!current()) return;
    turns = turns.filter(turn => turn !== draft);
    if (!question.value.trim()) question.value = text;
    if (!operation.controller.signal.aborted) showNotice(error.message);
    if (error.status === 401 || error.status === 409) { emptyConversation(); recheck = true; }
  } finally {
    clearInterval(operation.timer);
    if (pending === operation) {
      pending = null; finishWaiting(operation); render(); conversation.scrollTop = conversation.scrollHeight;
      if (recheck) await refreshSession();
    }
  }
});
addEventListener('focus', () => refreshSession());
addEventListener('pagehide', () => { active = false; invalidate(); emptyConversation(); turnsElement.replaceChildren(); });
addEventListener('pageshow', event => { active = true; if (event.persisted) refreshSession(); sync(); });
refreshSession();
if (location.hash === '#docs-chat') open();
