/* Text-only glyph for monospace surfaces: the guarded terminal, the ensemble-hook CLI while it
   waits for a decision, logs, and native TUIs. Frames trace the glyph's own loop:
   dot -> ring -> mark -> braid -> spark -> and back, so it reads as the same character as the SVG glyph. */
(function () {
  const FRAMES = ["·", "∘", "◡", "∪", "⋃", "≀", "⋈", "✢", "✣", "✳", "✣", "✢", "⋈", "≀", "⋃", "∪", "◡", "∘"];
  const VERBS = window.EnsembleStatus ? window.EnsembleStatus.VERBS : ["Harmonizing", "Weaving context", "Syncing up"];
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.reduceMotion === "true";
  window.EnsembleTermGlyph = {
    FRAMES,
    mount(el, o = {}) {
      let f = 0, v = 0, t0 = Date.now();
      const draw = () => {
        const s = Math.round((Date.now() - t0) / 1000);
        const g = reduced() ? "∪" : FRAMES[f % FRAMES.length];
        const verb = o.text || VERBS[v % VERBS.length] + "…";
        el.innerHTML = `<span class="tg">${g}</span> <span class="tv">${verb}</span> <span class="tm">(${s}s · ${o.hint || "esc to interrupt"})</span>`;
      };
      setInterval(() => { f++; draw(); }, 110);
      if (!o.text) setInterval(() => { v++; }, 2600);
      draw();
    },
  };
})();
