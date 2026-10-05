/* terminal.working: text-frame driver (vanilla, ~1.5 KB minified + frames JSON). Writes one character per frame into each
   .tw-text element. Keys: data-state (working|idle|done|error), nearest [data-motion-theme], optional
   data-set (glyph|safe|ascii). Reduced motion (OS or [data-reduce-motion="true"]) shows the state's still frame.
   No delay logic: it reacts to attribute changes immediately; the app's loader delay decides when to set them. */
(function (g) {
  'use strict';
  var FRAMES = /*FRAMES*/null;
  var RM = g.matchMedia ? g.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var live = new Set();
  function theme(el) { var t = el.closest('[data-motion-theme]'); return (t && t.getAttribute('data-motion-theme')) || 'expressive'; }
  function reduced(el) { return RM.matches || !!el.closest('[data-reduce-motion="true"]'); }
  function spec(el, data) {
    var set = data.sets[el.getAttribute('data-set') || 'glyph'] || data.sets.glyph;
    var st = set[theme(el)] || set.expressive;
    return st[el.getAttribute('data-state') || 'working'] || st.working;
  }
  function mount(el, opts) {
    if (el._tw) return el._tw;
    var data = (opts && opts.frames) || FRAMES, c = { el: el, t: 0, i: 0, key: '' };
    function paint(ch, tone) { if (el.textContent !== ch) el.textContent = ch; if (el.getAttribute('data-tone') !== tone) el.setAttribute('data-tone', tone); }
    function tick() {
      var sp = c.sp; paint(sp.frames[c.i], sp.tone);
      if (c.i < sp.frames.length - 1 || sp.loop) c.t = setTimeout(function () { c.i = (c.i + 1) % sp.frames.length; tick(); }, sp.ms[c.i]);
    }
    c.update = function (force) {
      var sp = spec(el, data), red = reduced(el), key = sp.frames.join('') + '|' + sp.tone + '|' + red;
      if (!force && key === c.key) return;            // unrelated mutation: don't restart the loop
      c.key = key; clearTimeout(c.t); c.sp = sp; c.i = 0;
      if (red) paint(sp.still, sp.tone); else tick();
    };
    c.destroy = function () { clearTimeout(c.t); live.delete(c); delete el._tw; };
    el._tw = c; live.add(c); c.update(true); return c;
  }
  function mountAll(root) { (root || document).querySelectorAll('.tw-text[data-motion-slot="terminal.working"]').forEach(function (el) { mount(el); }); }
  function refresh() { live.forEach(function (c) { if (!c.el.isConnected) c.destroy(); else c.update(false); }); }
  new MutationObserver(refresh).observe(document.documentElement, { subtree: true, attributes: true,
    attributeFilter: ['data-state', 'data-motion-theme', 'data-reduce-motion', 'data-set'] });
  if (RM.addEventListener) RM.addEventListener('change', refresh);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { mountAll(); }); else mountAll();
  g.EnsembleTerminal = { frames: FRAMES, mount: mount, mountAll: mountAll, refresh: refresh,
    /* for non-DOM renderers (a PTY, a canvas): the frame spec for a style/state/set */
    spec: function (style, state, set) { var s = FRAMES.sets[set || 'glyph']; return (s[style] || s.expressive)[state || 'working']; } };
})(window);
