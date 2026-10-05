/* EnsembleStatus: rotates whimsical verbs while the agent thinks; shows the real
   status (from SSE "status" frames) when there is one. Only real statuses are
   announced to screen readers, so the whimsy never spams assistive tech. */
(function () {
  const VERBS = ["Harmonizing", "Weaving context", "Finding the thread", "Syncing up", "Tuning in", "Braiding", "Composing",
    "Counterpointing", "Keeping time", "Stitching it together", "Cross-referencing", "Conducting", "Humming along",
    "Falling in step", "Resolving the chord", "Listening in", "Threading the needle", "Rehearsing", "Riffing", "Warming up"];
  const letters = (text) => [...text].map((c, i) => `<span class="l" style="--i:${i}">${c === " " ? "&nbsp;" : c}</span>`).join("");
  const fmt = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);
  class Status {
    constructor(el, o = {}) {
      this.el = el; this.verbs = o.verbs || VERBS; this.i = Math.floor(Math.random() * this.verbs.length);
      this.t0 = Date.now() - (o.elapsed || 0) * 1000; this.tokens = o.tokens || 0; this.hint = o.hint ?? "esc";
      el.classList.add("u-status");
      el.innerHTML = `<span class="g"></span><span class="u-status-slot" style="position:relative;display:inline-flex"></span>
        <span class="u-status-meta"></span><span class="u-sr" aria-live="polite"></span>`;
      this.glyph = window.EnsembleGlyph.mount(el.querySelector(".g"), { size: o.size || 16, state: "working" });
      this.slot = el.querySelector(".u-status-slot"); this.meta = el.querySelector(".u-status-meta"); this.sr = el.querySelector(".u-sr");
      this.show(this.verbs[this.i] + "…");
      this.timer = setInterval(() => this.tick(), 1000);
      this.rot = setInterval(() => { if (!this.real) { this.i = (this.i + 1) % this.verbs.length; this.show(this.verbs[this.i] + "…"); } }, o.interval || 2600);
      this.tick();
    }
    show(text) {
      const slot = this.slot, old = slot.querySelector(".u-status-verb:not(.out)");
      const from = slot.getBoundingClientRect().width;
      if (old) { old.classList.add("out"); setTimeout(() => old.remove(), 420); }
      const v = document.createElement("span"); v.className = "u-status-verb"; v.innerHTML = letters(text);
      slot.appendChild(v);
      if (!old) return;
      // glide the slot's width so the meta text never collides with the outgoing verb
      const to = v.getBoundingClientRect().width;
      slot.style.transition = "none"; slot.style.width = from + "px";
      requestAnimationFrame(() => { slot.style.transition = "width .38s var(--ease-weave)"; slot.style.width = Math.max(to, 0) + "px"; });
      clearTimeout(this.wt); this.wt = setTimeout(() => { slot.style.width = ""; slot.style.transition = ""; }, 460);
    }
    setReal(text) { this.real = text; this.el.classList.toggle("is-real", !!text); if (text) { this.show(text); this.sr.textContent = text; } }
    addTokens(n) { this.tokens += n; }
    tick() {
      const s = Math.round((Date.now() - this.t0) / 1000);
      const tk = this.tokens ? ` · ↓ ${this.tokens >= 1000 ? (this.tokens / 1000).toFixed(1) + "k" : this.tokens} tokens` : "";
      this.meta.innerHTML = `(${fmt(s)}${tk}${this.hint ? ` · <kbd>${this.hint}</kbd> to stop` : ""})`;
    }
    destroy() { clearInterval(this.timer); clearInterval(this.rot); }
  }
  window.EnsembleStatus = { mount: (el, o) => (el.__status = new Status(el, o)), VERBS };
})();
