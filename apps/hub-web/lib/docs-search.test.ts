import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
let html: string, searchDocs: unknown;
before(async () => {
  const renderer = await import(pathToFileURL(resolve(__dirname, '../../docs/src/render.mjs')).href);
  const search = await import(pathToFileURL(resolve(__dirname, '../../docs/src/search.js')).href); searchDocs = search.searchDocs;
  const page = { title: 'Docs', file: 'README.md', path: '/', toc: [], html: '<h1>Docs</h1>' }; html = renderer.pageHtml(page, [page], 'testing');
});
const source = readFileSync(resolve(__dirname, '../../docs/src/site-search.js'), 'utf8').replace(/^import .*;\n/gm, '').replace('export function mountSearch', 'function mountSearch');
const corpus = { version: 1, pages: [
  { title: 'Sharing · Share a page', path: '/share/', sections: [{ heading: 'Share a page', url: 'https://docs.ensemblework.com/share/', text: 'Choose Share on the page.' }] },
  { title: 'Sharing · Share a space', path: '/space/', sections: [{ heading: 'Share a space', url: 'https://docs.ensemblework.com/space/', text: 'Choose Share on the space.' }] },
  { title: 'Files', path: '/files/', sections: [{ heading: 'Files', url: 'https://docs.ensemblework.com/files/', text: 'Upload files.' }] },
] };
const settle = () => new Promise(resolve => setTimeout(resolve, 220));
function setup() {
  const dom = new JSDOM(html, { url: 'https://docs.ensemblework.com/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, dialog = w.document.querySelector<HTMLDialogElement>('#docs-search')!;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  dialog.showModal = () => dialog.setAttribute('open', '');
  dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new w.Event('close')); };
  let respond!: (value: Response) => void;
  w.fetch = (() => new Promise<Response>(resolve => { respond = resolve; })) as typeof w.fetch;
  (w as unknown as { searchDocs: unknown }).searchDocs = searchDocs;
  w.eval(`${source}\nmountSearch();`);
  const input = w.document.querySelector<HTMLInputElement>('#query')!;
  const type = (text: string) => { input.value = text; input.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const open = () => w.document.querySelector<HTMLButtonElement>('#search-trigger')!.click();
  return { dom, w, dialog, input, type, open, respond: () => respond(Response.json(corpus)), results: () => w.document.querySelector('#search-results')!, close: () => w.close() };
}

test('top-bar search updates as you type, highlights matches, and supports arrow selection', async () => {
  const p = setup();
  try {
    p.open(); p.respond(); p.type('share'); await settle();
    assert.equal(p.results().querySelectorAll('[role=option]').length, 2);
    assert.ok(p.results().querySelector('mark'));
    p.input.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(p.input.getAttribute('aria-activedescendant'), 'docs-result-1');
    p.type('zzzzunknown'); await settle();
    assert.equal(p.results().querySelectorAll('[role=option]').length, 0);
    assert.match(p.w.document.querySelector('#search-status')!.textContent!, /No matching/);
  } finally { p.close(); }
});
test('late index loads cannot show stale queries or reopen a dismissed search', async () => {
  const p = setup();
  try {
    p.open(); p.type('files'); await settle(); p.type('share'); await settle(); p.respond(); await settle();
    assert.match(p.results().textContent!, /Share a page/);
    assert.doesNotMatch(p.results().textContent!, /Upload files/);
    p.dialog.close(); p.type('files'); await settle();
    assert.equal(p.dialog.open, false);
    assert.equal(p.results().querySelectorAll('[role=option]').length, 0);
  } finally { p.close(); }
});
test('the shortcut opens search and closing returns focus to its top-bar entry', async () => {
  const p = setup();
  try {
    p.w.document.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    assert.equal(p.dialog.open, true);
    p.respond(); await settle(); p.dialog.close();
    assert.equal(p.w.document.activeElement?.id, 'search-trigger');
  } finally { p.close(); }
});
