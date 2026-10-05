/* Gallery wiring only. The slots themselves need nothing from this file. */
(function () {
  'use strict';
  var RESULTS = [
    ['Q3 OKRs: <mark>quarterly</mark> review', 'Doc · Planning', 'DOC'], ['Re: <mark>quarterly</mark> OKR check-in', 'Gmail · Priya', 'MAIL'],
    ['#leads: <mark>OKRs</mark> draft for Q4', 'Slack · 2d', '#'], ['<mark>Quarterly</mark> board deck', 'Drive · Finance', 'PPT'], ['Ask Ensemble: “summarise <mark>quarterly OKRs</mark>”', 'Agent', 'U']];
  var META = { typing: '', searching: 'Searching 4 sources…', results: '5 results · ↑↓ move · ↵ open', empty: '' };
  var STATES_R2 = ['idle', 'working', 'syncing', 'needs', 'done', 'error', 'paused', 'offline'];
  function press(group, v) { group.querySelectorAll('button[data-v]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.v === v)); }); }
  function restart(el) { var s = el.getAttribute('data-state'); el.removeAttribute('data-state'); void el.offsetWidth; el.setAttribute('data-state', s); }

  /* search.query */
  function fillSearch(card, st) {
    card.querySelectorAll('.sq').forEach(function (sq) {
      var q = st === 'empty' ? 'zebra roadmap' : 'quarterly okrs';
      sq.querySelector('.sq-input').value = q;
      sq.querySelector('[data-copy="status"]').textContent = META[st];
      sq.querySelector('[data-copy="empty-title"]').textContent = 'No matches for “' + q + '”';
      var ul = sq.querySelector('.sq-results');
      if (!ul.children.length) ul.innerHTML = RESULTS.map(function (r, i) {
        return '<li class="sq-item" role="option" aria-selected="' + (i === 0) + '" style="--i:' + i + '"><span class="ico">' + r[2] + '</span><span class="t"><b>' + r[0] + '</b><small>' + r[1] + '</small></span><span class="k">' + (i === 0 ? '↵' : '') + '</span></li>';
      }).join('');
      sq.setAttribute('data-state', st);
    });
  }
  /* terminal.working */
  function strip(card) {
    var el = card.querySelector('.tw-text'); if (!el || !window.EnsembleTerminal) return;
    var sp = EnsembleTerminal.spec(card.dataset.motionTheme, el.getAttribute('data-state'), el.getAttribute('data-set') || 'glyph');
    card.querySelector('#strip').innerHTML = sp.frames.map(function (f, i) {
      return '<span><i>' + f + '</i><em>' + (sp.ms[i] ? sp.ms[i] + 'ms' : 'hold') + '</em><em>U+' + f.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + '</em></span>';
    }).join('') + '<span><i>' + sp.still + '</i><em>still</em><em>reduce</em></span>';
    var labels = { working: 'Running tests…', idle: 'Waiting for input', done: 'Tests passed', error: '2 tests failed' };
    card.querySelectorAll('[data-label]').forEach(function (l) { l.textContent = labels[el.getAttribute('data-state')]; });
  }
  function fontcheck() {
    var out = document.getElementById('fontcheck'); if (!out || !document.fonts) return;
    Promise.all([document.fonts.load('14px "JetBrains Mono"', '·'), document.fonts.load('14px "Ensemble Frames"', '✳')]).then(function () {
      var jb = document.fonts.check('14px "JetBrains Mono"', '·'), uf = document.fonts.check('14px "Ensemble Frames"', '∪⋃≀⋈✢✣✳✓');
      out.innerHTML = 'fonts: JetBrains Mono <b class="' + (jb ? '' : 'no') + '">' + (jb ? 'loaded' : 'missing') + '</b> · Ensemble Frames <b class="' + (uf ? '' : 'no') + '">' + (uf ? 'loaded' : 'missing') + '</b>';
    });
  }
  /* tray */
  function stateSrc(style, st, kind) {
    if (style === 'expressive') return 'tray/states/expressive-round2/ensemble-tray-' + st + (kind === 'template' ? '-template' : '') + '.svg';
    return 'tray/states/minimal-round3/ensemble-' + style + '-' + st + '-' + kind + '.svg';
  }
  function tray(card) {
    var style = card.dataset.motionTheme, cur = card.dataset.trayState || 'idle';
    var mask = function (f) { return '<img class="tpl" src="tray/png/' + f + '" width="16" height="16" alt="">'; };
    var img = function (f, s) { return '<img src="tray/png/' + f + '" width="' + s + '" height="' + s + '" alt="">'; };
    card.querySelector('#bars').innerHTML =
      '<div class="bar mac-l"><span class="lab">macOS light · trayTemplate</span>' + mask('trayTemplate@2x.png') + '<span>Wed 09:41</span></div>' +
      '<div class="bar mac-d"><span class="lab">macOS dark · same template</span>' + mask('trayTemplate@2x.png') + '<span>Wed 09:41</span></div>' +
      '<div class="bar win-l"><span class="lab">Windows light · tray-accent-16</span>' + img('tray-accent-16@2x.png', 16) + '<span>09:41</span></div>' +
      '<div class="bar win-d"><span class="lab">Windows dark · tray-accent-light-16</span>' + img('tray-accent-light-16@2x.png', 16) + '<span>09:41</span></div>' +
      '<div class="bar lnx"><span class="lab">Linux dark panel · tray-accent-light-22</span>' + img('tray-accent-light-22.png', 22) + '<span>09:41</span></div>';
    var files = [];
    ['template', 'accent', 'accent-light'].forEach(function (c) { [16, 18, 22, 32].forEach(function (s) { [1, 2].forEach(function (k) {
      var n = c === 'template' ? (s === 16 ? 'trayTemplate' : 'tray' + s + 'Template') : 'tray-' + c + '-' + s;
      files.push([n + (k === 2 ? '@2x' : '') + '.png', s * k, c]); }); }); });
    card.querySelector('#pngs').innerHTML = files.map(function (f) {
      return '<figure class="' + (f[2] === 'accent' ? 'on-light' : f[2] === 'template' ? 'on-light' : 'on-dark') + '"><img src="tray/png/' + f[0] + '" width="' + f[1] + '" height="' + f[1] + '" alt=""><figcaption>' + f[0] + '</figcaption></figure>';
    }).join('');
    card.querySelector('#states').innerHTML = STATES_R2.map(function (st) {
      return '<figure class="tpl-l" aria-current="' + (st === cur) + '"><img src="' + stateSrc(style, st, 'template') + '" alt=""><figcaption>' + st + ' · tpl</figcaption></figure>' +
             '<figure class="tpl-d" aria-current="' + (st === cur) + '"><img src="' + stateSrc(style, st, style === 'expressive' ? 'color' : 'accent') + '" alt=""><figcaption>' + st + '</figcaption></figure>';
    }).join('');
  }
  function apply(card, key, v) {
    var g = card.querySelector('[data-ctl="' + key + '"]'); if (g) press(g, v);
    if (key === 'style') card.setAttribute('data-motion-theme', v);
    if (key === 'theme') card.setAttribute('data-theme', v);
    if (key === 'state') {
      if (card.id === 'card-search') fillSearch(card, v);
      else if (card.id === 'card-tray') card.dataset.trayState = v;
      else card.querySelectorAll('[data-motion-slot]').forEach(function (el) { el.setAttribute('data-state', v); });
    }
    if (key === 'set') card.querySelectorAll('.tw-text').forEach(function (el) { el.setAttribute('data-set', v); });
    if (card.id === 'card-term') strip(card);
    if (card.id === 'card-tray') tray(card);
  }
  var timers = [];
  document.querySelectorAll('.card').forEach(function (card) {
    card.querySelectorAll('[data-ctl]').forEach(function (g) {
      g.addEventListener('click', function (e) { var b = e.target.closest('button[data-v]'); if (b) { timers.forEach(clearTimeout); apply(card, g.dataset.ctl, b.dataset.v); } });
    });
    var rp = card.querySelector('[data-replay]');
    if (rp) rp.addEventListener('click', function () {
      card.querySelectorAll('[data-motion-slot]').forEach(function (el) { restart(el); if (el._tw) el._tw.update(true); });
    });
    var pl = card.querySelector('[data-play]');
    if (pl) pl.addEventListener('click', function () {
      timers.forEach(clearTimeout); apply(card, 'state', 'typing');
      timers = [setTimeout(function () { apply(card, 'state', 'searching'); }, 900), setTimeout(function () { apply(card, 'state', 'results'); }, 2700)];
    });
  });
  document.getElementById('global').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-g]'); if (!b) return; var v = b.dataset.g;
    if (v === 'reduce') { var on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on)); document.documentElement.setAttribute('data-reduce-motion', String(on)); return; }
    document.querySelectorAll('.card').forEach(function (c) { apply(c, (v === 'dark' || v === 'light') ? 'theme' : 'style', v); });
  });
  /* URL hooks for screenshots: ?style=minimal-dot&theme=light&search=results&term=done&tray=error&set=safe&reduce=1 */
  var q = new URLSearchParams(location.search);
  document.querySelectorAll('.card').forEach(function (c) {
    if (q.get('style')) apply(c, 'style', q.get('style'));
    if (q.get('theme')) apply(c, 'theme', q.get('theme'));
  });
  if (q.get('reduce')) document.documentElement.setAttribute('data-reduce-motion', 'true');
  apply(document.getElementById('card-search'), 'state', q.get('search') || 'typing');
  apply(document.getElementById('card-term'), 'state', q.get('term') || 'working');
  if (q.get('set')) apply(document.getElementById('card-term'), 'set', q.get('set'));
  apply(document.getElementById('card-tray'), 'state', q.get('tray') || 'idle');
  fontcheck();
})();
