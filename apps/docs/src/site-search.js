import { searchDocs } from './search.js';

export function mountSearch() {
  const dialog = document.querySelector('#docs-search');
  const trigger = document.querySelector('#search-trigger');
  const form = document.querySelector('#search-form');
  const input = document.querySelector('#query');
  const results = document.querySelector('#search-results');
  const status = document.querySelector('#search-status');
  let publication, loading, timer, generation = 0, selected = -1, hits = [], pending = false, enterPending = null;
  const apple = /Mac|iPhone|iPad/.test(navigator.platform);
  trigger.querySelector('kbd').textContent = apple ? '⌘ K' : 'Ctrl K';
  function highlight(element, text, query) {
    const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
    const pattern = words.length ? new RegExp(`(${words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu') : null;
    if (!pattern) { element.textContent = text; return; }
    for (const part of text.split(pattern)) {
      if (words.includes(part.toLowerCase())) { const mark = document.createElement('mark'); mark.textContent = part; element.append(mark); }
      else element.append(document.createTextNode(part));
    }
  }
  function select(index) {
    selected = index;
    for (const [i, item] of [...results.querySelectorAll('[role="option"]')].entries()) item.setAttribute('aria-selected', String(i === selected));
    if (selected >= 0) {
      input.setAttribute('aria-activedescendant', `docs-result-${selected}`);
      document.getElementById(`docs-result-${selected}`)?.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }
  function go(index) {
    const hit = hits[index];
    if (!hit || pending) return;
    const target = new URL(hit.url);
    if (target.origin === 'https://docs.ensemblework.com') location.assign(target.pathname + target.hash);
  }
  function render(query) {
    results.replaceChildren();
    for (const [index, hit] of hits.entries()) {
      const item = document.createElement('div'); item.id = `docs-result-${index}`; item.className = 'docs-search-hit'; item.role = 'option'; item.setAttribute('aria-selected', 'false');
      const label = document.createElement('strong'); highlight(label, hit.heading, query);
      const guide = document.createElement('span'); guide.className = 'docs-search-guide'; guide.textContent = hit.title.split(' · ')[0];
      const excerpt = document.createElement('p'); highlight(excerpt, hit.excerpt, query);
      const arrow = document.createElement('span'); arrow.className = 'docs-search-open'; arrow.textContent = '↵'; arrow.setAttribute('aria-hidden', 'true');
      item.append(guide, label, excerpt, arrow);
      item.addEventListener('pointermove', () => select(index));
      item.addEventListener('mousedown', event => event.preventDefault());
      item.addEventListener('click', () => go(index));
      results.append(item);
    }
    select(hits.length ? 0 : -1);
  }
  async function run() {
    const current = ++generation;
    const query = input.value.trim();
    pending = true; hits = []; select(-1); results.replaceChildren();
    dialog.dataset.searching = 'true'; status.textContent = 'Searching the docs…';
    try {
      if (!publication) {
        loading ??= fetch('/search-index.json', { credentials: 'omit' }).then(response => { if (!response.ok) throw Error('unavailable'); return response.json(); }).finally(() => { loading = null; });
        publication = await loading;
      }
      if (current !== generation || !dialog.open) return;
      if (query) hits = searchDocs(publication, query, 12).results;
      else hits = ['/00_project_overview/', '/28_ensemble_spaces/', '/29_sharing/', '/31_connectors_in_use/', '/32_files/', '/40_public_documentation/'].flatMap(path => {
        const page = publication.pages.find(page => page.path === path);
        const section = page?.sections[0];
        return page && section ? [{ title: page.title, heading: page.title, url: section.url, excerpt: section.text.slice(0, 180) }] : [];
      });
      pending = false; dialog.dataset.searching = 'false';
      status.textContent = query ? hits.length ? `${hits.length} matching topics` : 'No matching topics. Try fewer words or another phrase.' : 'Explore the docs';
      render(query);
      if (enterPending === current) go(0);
    } catch {
      if (current !== generation || !dialog.open) return;
      pending = false; dialog.dataset.searching = 'false';
      status.textContent = 'Search could not load. Try again or browse All guides.';
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry search'; retry.addEventListener('click', run); results.append(retry);
    }
  }
  function schedule() {
    clearTimeout(timer); generation++; enterPending = null; pending = true; hits = []; select(-1); results.replaceChildren();
    status.textContent = 'Searching the docs…'; dialog.dataset.searching = 'true';
    timer = setTimeout(run, 180);
  }
  function open() { if (!dialog.open) dialog.showModal(); input.focus(); input.select(); run(); }
  trigger.addEventListener('click', open);
  document.querySelector('#search-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { clearTimeout(timer); generation++; enterPending = null; pending = false; trigger.focus(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
  input.addEventListener('input', schedule);
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); if (hits.length) select((selected + (event.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length);
    }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (pending) { clearTimeout(timer); enterPending = generation + 1; run(); }
    else go(selected);
  });
  document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); open(); } });
  input.value = new URL(location.href).searchParams.get('q') ?? '';
  if (input.value) open();
}
