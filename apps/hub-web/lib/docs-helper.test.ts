import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

let html = '', source = '';
before(async () => {
  const docs = createRequire(resolve(__dirname, '../../docs/package.json'));
  const { buildSync } = docs('esbuild');
  source = buildSync({ entryPoints: [docs.resolve('./src/helper.js')], bundle: true, format: 'iife', write: false }).outputFiles[0].text;
  const renderer = await import(pathToFileURL(resolve(__dirname, '../../docs/src/render.mjs')).href);
  const page = { title: 'Guide', file: 'README.md', path: '/', toc: [], html: '<h1>Guide</h1>' };
  html = renderer.pageHtml(page, [page], 'testing');
});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const accountA = { id: 'account-a', name: 'Mira' }, accountB = { id: 'account-b', name: 'Ben' };
const turnA = { id: 'turn-a', question: 'Private A question', answer: 'Private A answer', sources: [] };
const session = (user: typeof accountA | null) => ({ user, loginUrl: 'https://app.ensemblework.com/login' });

type PendingRequest = { path: string; method: string; options: RequestInit; resolve: (value: Response) => void; reject: (error: Error) => void; taken?: boolean };
function setup() {
  const dom = new JSDOM(html, { url: 'https://docs.ensemblework.com/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const requests: PendingRequest[] = [];
  Object.defineProperty(w, 'AbortSignal', { value: AbortSignal });
  Object.defineProperty(w, 'AbortController', { value: AbortController });
  w.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof w.matchMedia;
  w.HTMLElement.prototype.scrollTo = () => {};
  w.fetch = ((url: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
    requests.push({ path: new URL(url).pathname + new URL(url).search, method: options.method ?? 'GET', options, resolve, reject });
  })) as typeof w.fetch;
  w.eval(source);
  const element = <T extends Element = HTMLElement>(selector: string) => w.document.querySelector<T>(selector)!;
  const click = (selector: string) => element<HTMLElement>(selector).click();
  click('#docs-launcher');
  function take(path: string, method = 'GET') {
    const row = requests.find(item => !item.taken && item.path === path && item.method === method);
    assert.ok(row, `Missing ${method} ${path}: ${requests.map(r => `${r.method} ${r.path}`).join(', ')}`);
    row.taken = true;
    return row;
  }
  async function answer(row: PendingRequest, body: unknown, status = 200) {
    row.resolve(status === 204 ? new Response(null, { status }) : Response.json(body, { status }));
    await tick(); await tick();
  }
  async function signedIn(user = accountA, turns = [turnA], before: string | null = null) {
    await answer(take('/api/docs/session'), session(user));
    await answer(take('/api/docs/history'), { turns, before });
  }
  function send(text: string) {
    const input = element<HTMLTextAreaElement>('#helper-question'); input.value = text;
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    element<HTMLFormElement>('#helper-form').requestSubmit();
  }
  return { w, element, click, take, answer, signedIn, send, requests, close: () => dom.window.close() };
}

test('a delayed history page cannot restore messages after clearing them', async () => {
  const page = setup();
  try {
    await page.signedIn(accountA, [turnA], 'older');
    page.click('#helper-earlier');
    const delayed = page.take('/api/docs/history?before=older');
    page.click('#helper-clear'); page.click('#helper-delete');
    await page.answer(page.take('/api/docs/history', 'DELETE'), null, 204);
    await page.answer(delayed, { turns: [{ ...turnA, id: 'older' }], before: null });
    assert.equal(page.element('#helper-turns').textContent, '');
  } finally { page.close(); }
});

test('focus rechecks a changed account during an answer and discards its late response', async () => {
  const page = setup();
  try {
    await page.signedIn();
    page.send('Connect an app');
    const pending = page.take('/api/docs/ask', 'POST');
    page.w.dispatchEvent(new page.w.Event('focus'));
    assert.equal(page.element('#helper-turns').textContent, '', 'private content is hidden until sign-in is checked');
    await page.answer(page.take('/api/docs/session'), session(accountB));
    await page.answer(page.take('/api/docs/history'), { turns: [], before: null });
    await page.answer(pending, { answer: 'Late private A answer', sources: [], saved: true });
    assert.equal(page.element('#helper-turns').textContent, '');
    assert.match(page.element('#helper-account').textContent!, /Ben/);
    assert.equal(pending.options.signal?.aborted, true);
  } finally { page.close(); }
});

test('initial history loading cannot swallow a newly submitted question', async () => {
  const page = setup();
  try {
    await page.answer(page.take('/api/docs/session'), session(accountA));
    const history = page.take('/api/docs/history');
    page.send('Connect an app');
    assert.equal(page.requests.filter(row => row.path === '/api/docs/ask').length, 0, 'submission waits for initial history');
    await page.answer(history, { turns: [], before: null });
    page.send('Connect an app');
    await page.answer(page.take('/api/docs/ask', 'POST'), { saved: true, turn: { id: 'new', question: 'Connect an app', answer: 'Open Connections', sources: [] } });
    assert.match(page.element('#helper-turns').textContent!, /Connect an app.*Open Connections/);
  } finally { page.close(); }
});

test('session failures have a retry that restores history and consistent controls', async () => {
  const page = setup();
  try {
    await page.signedIn();
    page.w.dispatchEvent(new page.w.Event('focus'));
    page.take('/api/docs/session').reject(new Error('offline'));
    await tick();
    assert.equal(page.element('#helper-turns').textContent, '');
    assert.match(page.element('#helper-account').textContent!, /unavailable/);
    assert.equal(page.element<HTMLElement>('#helper-auth-recovery').hidden, false);
    page.send('Connect an app');
    assert.equal(page.requests.filter(row => row.path === '/api/docs/ask').length, 0);
    page.click('#helper-retry-session');
    await page.answer(page.take('/api/docs/session'), session(accountA));
    assert.match(page.element('#helper-turns').textContent!, /Private A question/);
    assert.equal(page.element<HTMLElement>('#helper-auth-recovery').hidden, true);
  } finally { page.close(); }
});

test('a stale history read cannot restore signed-in content after logout', async () => {
  const page = setup();
  try {
    await page.signedIn(accountA, [turnA], 'older');
    // The pending history page is invalidated by sign-out even for the same account.
    page.click('#helper-earlier');
    const delayed = page.take('/api/docs/history?before=older');
    page.click('#helper-logout');
    await page.answer(page.take('/api/docs/logout', 'POST'), null, 204);
    await page.answer(delayed, { turns: [turnA], before: null });
    assert.equal(page.element('#helper-turns').textContent, '');
    assert.match(page.element('#helper-account').textContent!, /Guest/);
  } finally { page.close(); }
});

test('continuing as a guest is explicit and sends no persistence or credentials', async () => {
  const page = setup();
  try {
    page.take('/api/docs/session').reject(new Error('offline'));
    await tick(); page.click('#helper-guest');
    page.send('Connect an app');
    const request = page.take('/api/docs/ask', 'POST');
    assert.equal(request.options.credentials, 'omit');
    assert.deepEqual(JSON.parse(String(request.options.body)), { question: 'Connect an app' });
    await page.answer(request, { answer: 'Open Connections', sources: [] });
    page.w.dispatchEvent(new page.w.Event('pagehide'));
    assert.equal(page.element('#helper-turns').textContent, '');
  } finally { page.close(); }
});

test('account verification hides an unsent draft and switching accounts discards it', async () => {
  const page = setup();
  try {
    await page.signedIn();
    page.element<HTMLTextAreaElement>('#helper-question').value = 'Private A draft';
    page.w.dispatchEvent(new page.w.Event('focus'));
    assert.equal(page.element<HTMLTextAreaElement>('#helper-question').style.visibility, 'hidden');
    assert.equal(page.element<HTMLTextAreaElement>('#helper-question').readOnly, true);
    await page.answer(page.take('/api/docs/session'), session(accountB));
    await page.answer(page.take('/api/docs/history'), { turns: [], before: null });
    assert.equal(page.element<HTMLTextAreaElement>('#helper-question').value, '');
  } finally { page.close(); }
});

test('New chat starts empty without erasing history, and History opens a selectable list', async () => {
  const page = setup();
  try {
    await page.signedIn();
    page.click('#helper-new');
    assert.equal(page.element('#helper-turns').textContent, '');
    page.send('A fresh question');
    const sent = page.take('/api/docs/ask', 'POST');
    const payload = JSON.parse(String(sent.options.body));
    assert.match(payload.chatId, /^[\da-f-]{36}$/);
    await page.answer(sent, { saved: true, answer: 'Fresh answer', sources: [] });
    page.click('#helper-history');
    assert.equal(page.element<HTMLElement>('#helper-history-panel').hidden, false);
    await page.answer(page.take('/api/docs/chats'), { chats: [{ id: 'legacy', title: 'Private A question', updatedAt: new Date().toISOString() }], before: null });
    page.click('.helper-chat-item');
    await page.answer(page.take('/api/docs/history?chatId=legacy'), { chatId: 'legacy', turns: [turnA], before: null });
    assert.match(page.element('#helper-turns').textContent!, /Private A question/);
    assert.equal(page.element<HTMLElement>('#helper-history-panel').hidden, true);
    assert.equal(page.requests.filter(row => row.method === 'DELETE').length, 0);
  } finally { page.close(); }
});

test('a pending clear hides conversation titles before an account can change', async () => {
  const page = setup();
  try {
    await page.signedIn(); page.click('#helper-history');
    await page.answer(page.take('/api/docs/chats'), { chats: [{ id: 'legacy', title: 'Private A title', updatedAt: new Date().toISOString() }], before: null });
    page.click('#helper-clear'); page.click('#helper-delete');
    const clear = page.take('/api/docs/history', 'DELETE');
    page.w.dispatchEvent(new page.w.Event('focus'));
    assert.equal(page.element<HTMLElement>('#helper-history-panel').hidden, true);
    assert.equal(page.element('#helper-chat-list').textContent, '');
    await page.answer(clear, null, 204);
    await page.answer(page.take('/api/docs/session'), session(accountB));
    await page.answer(page.take('/api/docs/history'), { turns: [], before: null });
    assert.doesNotMatch(page.element('#docs-helper').textContent!, /Private A title/);
  } finally { page.close(); }
});

test('a failed old chat-list request cannot overwrite a reopened History panel', async () => {
  const page = setup();
  try {
    await page.signedIn(); page.click('#helper-history');
    const old = page.take('/api/docs/chats');
    page.click('#helper-history-close'); page.click('#helper-history');
    await page.answer(page.take('/api/docs/chats'), { chats: [{ id: 'legacy', title: 'Current chat', updatedAt: new Date().toISOString() }], before: null });
    old.reject(new Error('Old failure')); await tick();
    assert.match(page.element('#helper-chat-list').textContent!, /Current chat/);
    assert.doesNotMatch(page.element('#helper-chat-list').textContent!, /Old failure/);
  } finally { page.close(); }
});
