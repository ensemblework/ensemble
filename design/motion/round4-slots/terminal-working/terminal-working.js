/* terminal.working: text-frame driver (vanilla, ~1.5 KB minified + frames JSON). Writes one character per frame into each
   .tw-text element. Keys: data-state (working|idle|done|error), nearest [data-motion-theme], optional
   data-set (glyph|safe|ascii). Reduced motion (OS or [data-reduce-motion="true"]) shows the state's still frame.
   No delay logic: it reacts to attribute changes immediately; the app's loader delay decides when to set them. */
(function (g) {
  'use strict';
  var FRAMES = {"version":1,"slot":"terminal.working","note":"Per style and state: frames[] and ms[] (same length; how long each frame shows). loop=false holds the last frame. still = the single frame used under reduced motion. tone maps to a CSS colour token (.tw[data-tone]). No delay logic: the app decides when the state changes.","fontFamily":"\"JetBrains Mono\", \"Ensemble Frames\", ui-monospace, SFMono-Regular, Menlo, Consolas, \"DejaVu Sans Mono\", monospace","sets":{"glyph":{"note":"Round-1 Terminal glyph family. Needs JetBrains Mono + Ensemble Frames (shipped) for ◡ ∪ ⋃ ≀ ⋈ ✢ ✣ ✳ ✓.","expressive":{"working":{"frames":["·","∘","◡","∪","⋃","≀","⋈","✢","✣","✳︎","✣","✢","⋈","≀","⋃","∪","◡","∘"],"ms":[80,80,80,240,90,90,90,80,80,260,80,80,90,90,90,240,80,80],"loop":true,"tone":"accent","still":"∪"},"idle":{"frames":["∪"],"ms":[0],"loop":false,"tone":"faint","still":"∪"},"done":{"frames":["∪","⋃","✓"],"ms":[70,90,0],"loop":false,"tone":"ok","still":"✓"},"error":{"frames":["⋈","≀","✕"],"ms":[70,110,0],"loop":false,"tone":"err","still":"✕"}},"minimal-quiet":{"working":{"frames":["◡","∪","⋃","∪"],"ms":[360,520,360,520],"loop":true,"tone":"muted","still":"∪"},"idle":{"frames":["∪"],"ms":[0],"loop":false,"tone":"faint","still":"∪"},"done":{"frames":["✓"],"ms":[0],"loop":false,"tone":"muted","still":"✓"},"error":{"frames":["≀"],"ms":[0],"loop":false,"tone":"err","still":"≀"}},"minimal-dot":{"working":{"frames":["·","•","●","•"],"ms":[520,260,520,260],"loop":true,"tone":"accent","still":"•"},"idle":{"frames":["·"],"ms":[0],"loop":false,"tone":"faint","still":"·"},"done":{"frames":["•"],"ms":[0],"loop":false,"tone":"ink","still":"•"},"error":{"frames":["∘"],"ms":[0],"loop":false,"tone":"err","still":"∘"}}},"safe":{"note":"Only characters every JetBrains Mono build has (no extra font needed): for a real terminal/PTY or a webview that can't load Ensemble Frames.","expressive":{"working":{"frames":["·","∘","◌","◯","◎","●","◎","◯","◌","∘"],"ms":[90,90,90,90,110,220,110,90,90,90],"loop":true,"tone":"accent","still":"◎"},"idle":{"frames":["∘"],"ms":[0],"loop":false,"tone":"faint","still":"∘"},"done":{"frames":["◎","●"],"ms":[90,0],"loop":false,"tone":"ok","still":"●"},"error":{"frames":["×","✕"],"ms":[90,0],"loop":false,"tone":"err","still":"✕"}},"minimal-quiet":{"working":{"frames":["◌","◯","◌","∘"],"ms":[420,420,420,420],"loop":true,"tone":"muted","still":"◯"},"idle":{"frames":["∘"],"ms":[0],"loop":false,"tone":"faint","still":"∘"},"done":{"frames":["●"],"ms":[0],"loop":false,"tone":"muted","still":"●"},"error":{"frames":["×"],"ms":[0],"loop":false,"tone":"err","still":"×"}},"minimal-dot":{"working":{"frames":["·","•"],"ms":[700,700],"loop":true,"tone":"accent","still":"•"},"idle":{"frames":["·"],"ms":[0],"loop":false,"tone":"faint","still":"·"},"done":{"frames":["•"],"ms":[0],"loop":false,"tone":"ink","still":"•"},"error":{"frames":["∘"],"ms":[0],"loop":false,"tone":"err","still":"∘"}}},"ascii":{"note":"7-bit fallback for logs, CI output and any font.","expressive":{"working":{"frames":[".","o","O","o"],"ms":[110,110,220,110],"loop":true,"tone":"accent","still":"o"},"idle":{"frames":["."],"ms":[0],"loop":false,"tone":"faint","still":"."},"done":{"frames":["*"],"ms":[0],"loop":false,"tone":"ok","still":"*"},"error":{"frames":["x"],"ms":[0],"loop":false,"tone":"err","still":"x"}},"minimal-quiet":{"working":{"frames":[".","o"],"ms":[520,520],"loop":true,"tone":"muted","still":"o"},"idle":{"frames":["."],"ms":[0],"loop":false,"tone":"faint","still":"."},"done":{"frames":["*"],"ms":[0],"loop":false,"tone":"muted","still":"*"},"error":{"frames":["x"],"ms":[0],"loop":false,"tone":"err","still":"x"}},"minimal-dot":{"working":{"frames":[".",":"],"ms":[700,700],"loop":true,"tone":"accent","still":":"},"idle":{"frames":["."],"ms":[0],"loop":false,"tone":"faint","still":"."},"done":{"frames":["*"],"ms":[0],"loop":false,"tone":"ink","still":"*"},"error":{"frames":["x"],"ms":[0],"loop":false,"tone":"err","still":"x"}}}}};
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
