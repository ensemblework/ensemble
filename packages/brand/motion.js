'use strict';
const { staticSVG } = require('./index.js');
const { createModel, kinds, path, ease, clamp } = require('./geometry.js');
const data = require('./motion-data.json');
const model = createModel(data);
const BASE = { once: .72, loop: 3.4, loopLarge: 3.4, settle: .34, ramp: .66, onceRamp: .3, settleEase: 'out' };
const actors = new Set();
let uid = 0, raf = 0, last = 0, observer, media;
const reduced = el => el.closest('[data-reduce-motion="true"]') !== null || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
const active = a => a.visible && !a.reduced && ['loop', 'once', 'settle'].includes(a.state);
function schedule() {
    if (!raf && typeof document !== 'undefined' && !document.hidden && [...actors].some(active))
        raf = requestAnimationFrame(tick);
}
function tick(now) {
    raf = 0;
    if (now - last >= 1000 / 30) {
        last = now;
        for (const actor of actors)
            if (active(actor))
                actor.tick(now);
    }
    schedule();
}
function refresh() {
    for (const actor of actors)
        actor.refresh();
    if (typeof document !== 'undefined' && (document.hidden || ![...actors].some(active))) {
        cancelAnimationFrame(raf);
        raf = 0;
    }
    schedule();
}
function listen() {
    if (actors.size !== 1 || typeof document === 'undefined')
        return;
    document.addEventListener('visibilitychange', refresh);
    media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    media?.addEventListener('change', refresh);
    if (typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver(refresh);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduce-motion'] });
    }
}
function unlisten() {
    if (actors.size || typeof document === 'undefined')
        return;
    document.removeEventListener('visibilitychange', refresh);
    media?.removeEventListener('change', refresh);
    observer?.disconnect();
    observer = null;
    cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
}
function mount(el, opts = {}) {
    const size = opts.size || Number(el.dataset.size) || 24;
    const id = `woven-motion-${++uid}`;
    const tone = opts.tone || 'auto';
    const gold = tone === 'auto' || tone === 'gold';
    el.dataset.tone = tone;
    let kind = opts.kind || el.dataset.kind || 'infinity';
    let state = 'idle', visible = true, started = 0, current = model.base, from = model.base;
    let pending = 0, destroyed = false, resolve = null;
    const small = size <= 20;
    el.classList.add('u-morph');
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    if (!el.getAttribute('aria-label'))
        el.setAttribute('aria-hidden', 'true');
    const stops = list => list.map(([offset, color]) => `<stop offset="${offset}" stop-color="${color}"/>`).join('');
    el.innerHTML = `<span class="wm-rest">${staticSVG(size, { id: id + "-rest", tone })}</span><svg class="wm-live" viewBox="${opts.flat ? '0 128 320 64' : '0 0 320 320'}" ${opts.flat ? 'preserveAspectRatio="none"' : ''} aria-hidden="true"><defs><linearGradient id="${id}-a" x1="77" y1="60" x2="247" y2="269" gradientUnits="userSpaceOnUse">${stops(data.goldA)}</linearGradient><linearGradient id="${id}-b" x1="224" y1="64" x2="106" y2="272" gradientUnits="userSpaceOnUse">${stops(data.goldB)}</linearGradient><mask id="${id}-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="320" height="320"><rect width="320" height="320" fill="white"/><path class="wm-cut" fill="none" stroke="black" stroke-linecap="round"/></mask></defs><g fill="none" stroke-linecap="round" stroke-linejoin="round"><path class="wm-a" mask="url(#${id}-cut)" stroke="${gold ? `url(#${id}-a)` : 'currentColor'}"/><path class="wm-b" stroke="${gold ? `url(#${id}-b)` : 'currentColor'}"/><path class="wm-spark" mask="url(#${id}-cut)" stroke="${gold ? '#FFF3D2' : 'currentColor'}" opacity=".55" pathLength="1000" stroke-dasharray="55 945"/></g></svg>`;
    if (opts.flat) {
        el.dataset.flat = 'true';
        el.style.width = '100%';
        el.style.height = '8px';
    }
    if (tone === 'white' || tone === 'ink')
        el.style.color = tone === 'white' ? '#FFFFFF' : '#1C1915';
    const rest = el.querySelector('.wm-rest'), live = el.querySelector('.wm-live');
    const a = el.querySelector('.wm-a'), b = el.querySelector('.wm-b'), cut = el.querySelector('.wm-cut'), spark = el.querySelector('.wm-spark');
    function paint(frame, opacity = 0, phase = 0) {
        current = frame;
        const da = path(frame.pair[0]), db = path(frame.pair[1]), w = frame.width * (small ? 1.4 : 1);
        a.setAttribute('d', da);
        b.setAttribute('d', db);
        cut.setAttribute('d', db);
        spark.setAttribute('d', da);
        a.setAttribute('stroke-width', w);
        b.setAttribute('stroke-width', w);
        cut.setAttribute('stroke-width', w + 4);
        spark.setAttribute('stroke-width', w * .27);
        spark.setAttribute('stroke-dashoffset', -phase / (Math.PI * 2) * 1000);
        rest.style.opacity = String(opacity);
        live.style.opacity = String(1 - opacity);
        el.dataset.pose = opacity === 1 ? 'logo' : kind;
    }
    function finish() { const done = resolve; resolve = null; done?.(); }
    function cancel() { clearTimeout(pending); pending = 0; finish(); }
    function idle() {
        cancel();
        state = 'idle';
        delete el.dataset.running;
        el.dataset.state = 'idle';
        paint(model.base, 1);
        el.dispatchEvent(new Event('ensemble:morph-idle'));
    }
    const actor = {
        get state() { return state; }, get visible() { return visible; }, get reduced() { return reduced(el); },
        tick(now) {
            if (destroyed)
                return;
            const elapsed = now - started;
            if (state === 'settle') {
                const k = clamp(elapsed / 340);
                paint(model.settle(from, k), ease((k - .7) / .3));
                if (k >= 1)
                    idle();
                return;
            }
            if (state === 'once') {
                const k = clamp(elapsed / 720), amount = k < .43 ? ease(k / .43) : 1 - ease((k - .43) / .57);
                paint(model.pose('unfurl', amount), amount < .08 ? 1 - amount / .08 : 0);
                if (k >= 1)
                    idle();
                return;
            }
            const amount = clamp(elapsed / kinds[kind].duration), phase = elapsed / kinds[kind].loop * Math.PI * 2;
            paint(model.pose(kind, amount, phase), amount < .06 ? 1 - amount / .06 : 0, phase);
        },
        refresh() {
            const reduce = reduced(el);
            el.dataset.reduced = String(reduce);
            if (reduce) {
                paint(model.base, 1);
                if (state === 'once' || state === 'settle')
                    idle();
            }
        },
        once() {
            cancel();
            kind = 'unfurl';
            if (destroyed || reduced(el)) {
                idle();
                return Promise.resolve();
            }
            state = 'once';
            started = performance.now();
            el.dataset.running = 'true';
            el.dataset.state = state;
            schedule();
            return new Promise(done => { resolve = done; });
        },
        loop({ delay = 0, kind: next = opts.kind || 'infinity' } = {}) {
            if (!kinds[next] || next === 'unfurl')
                next = 'infinity';
            if ((state === 'loop' || state === 'pending') && kind === next) {
                actor.refresh();
                schedule();
                return actor;
            }
            cancel();
            kind = next;
            const start = () => { if (destroyed)
                return; pending = 0; state = 'loop'; started = performance.now(); el.dataset.running = 'true'; el.dataset.state = state; actor.refresh(); schedule(); };
            if (delay > 0) {
                state = 'pending';
                delete el.dataset.running;
                pending = setTimeout(start, delay);
            }
            else
                start();
            return actor;
        },
        settle() {
            if (destroyed || state === 'idle' || state === 'pending' || reduced(el) || !visible || (typeof document !== 'undefined' && document.hidden)) {
                idle();
                return Promise.resolve();
            }
            cancel();
            from = current;
            state = 'settle';
            started = performance.now();
            el.dataset.state = state;
            schedule();
            return new Promise(done => { resolve = done; });
        },
        idle,
        seek(mode, seconds) { cancel(); state = 'idle'; kind = mode === 'once' ? 'unfurl' : opts.kind || 'infinity'; const f = model.cycle(kind, seconds); paint(f.frame, f.rest, f.phase); },
        destroy() { destroyed = true; cancel(); intersection?.disconnect(); actors.delete(actor); unlisten(); el.innerHTML = ''; }
    };
    const intersection = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
        visible = entries[0].isIntersecting;
        if (!visible && (state === 'once' || state === 'settle'))
            idle();
        if (visible) {
            actor.refresh();
            schedule();
        }
    }) : null;
    intersection?.observe(el);
    actors.add(actor);
    listen();
    paint(model.base, 1);
    actor.refresh();
    return actor;
}
function autoMount(scope = document) { return [...scope.querySelectorAll('[data-motion-slot="brand.morph"]')].map(el => { const state = el.dataset.state; const ctl = mount(el); if (state === 'loop')
    ctl.loop();
else if (state === 'once')
    void ctl.once(); return ctl; }); }
module.exports = { staticSVG, mount, autoMount, BASE, kinds };
