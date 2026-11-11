'use strict';
const { staticSVG } = require('./index.js');
const { createModel, kinds, path, ease, clamp, SETTLE_MS } = require('./geometry.js');
const data = require('./motion-data.json');
const model = createModel(data);
const BASE = { once: kinds.unfurl.duration / 1000, loop: kinds.infinity.loop / 1000, loopLarge: kinds.infinity.loop / 1000, settle: SETTLE_MS / 1000, ramp: kinds.infinity.duration / 1000, onceRamp: .3, settleEase: 'quintic' };
const actors = new Set();
let uid = 0, raf = 0, wakeTimer = 0, wakeAt = Infinity, last = -Infinity, observer, media;
const active = actor => actor.visible && !actor.reduced && ['loop', 'once', 'settle'].includes(actor.state);

function stopScheduling() {
    if (raf) cancelAnimationFrame(raf);
    clearTimeout(wakeTimer);
    raf = 0;
    wakeTimer = 0;
    wakeAt = Infinity;
    last = -Infinity;
}
function schedule() {
    if (typeof document === 'undefined' || document.hidden) {
        stopScheduling();
        return;
    }
    const now = performance.now();
    let wait = Infinity;
    for (const actor of actors)
        if (active(actor)) wait = Math.min(wait, actor.nextFrame(now));
    if (!Number.isFinite(wait)) {
        stopScheduling();
        return;
    }
    if (wait <= 0) {
        clearTimeout(wakeTimer);
        wakeTimer = 0;
        wakeAt = Infinity;
        if (!raf) raf = requestAnimationFrame(tick);
        return;
    }
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    const deadline = now + wait;
    if (!wakeTimer || Math.abs(deadline - wakeAt) > 1) {
        clearTimeout(wakeTimer);
        wakeAt = deadline;
        wakeTimer = setTimeout(() => { wakeTimer = 0; wakeAt = Infinity; schedule(); }, Math.max(1, wait));
    }
}
function tick(now) {
    raf = 0;
    if (typeof document === 'undefined' || document.hidden) {
        stopScheduling();
        return;
    }
    if (now - last >= 1000 / 30) {
        last = now;
        for (const actor of actors)
            if (active(actor)) actor.tick(now);
    }
    schedule();
}
function refresh() {
    for (const actor of actors) actor.refresh();
    schedule();
}
function listen() {
    if (actors.size !== 1 || typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', refresh);
    media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    media?.addEventListener('change', refresh);
    if (typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver(refresh);
        observer.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['data-reduce-motion'] });
    }
}
function unlisten() {
    if (actors.size || typeof document === 'undefined') return;
    document.removeEventListener('visibilitychange', refresh);
    media?.removeEventListener('change', refresh);
    media = null;
    observer?.disconnect();
    observer = null;
    stopScheduling();
}

function mount(el, opts = {}) {
    const size = opts.size || Number(el.dataset.size) || 24;
    const id = `woven-motion-${++uid}`, tone = opts.tone || 'auto';
    const gold = tone === 'auto' || tone === 'gold', flat = opts.flat ?? el.dataset.flat === 'true';
    const defaultKind = Object.hasOwn(kinds, opts.kind || el.dataset.kind || '') ? opts.kind || el.dataset.kind : 'infinity';
    let kind = defaultKind, state = 'idle', visible = true, reduced = false, started = 0, pausedAt = null;
    let current = model.base, currentRest = 1, from = model.base, fromRest = 1, handoff = null;
    let pending = 0, destroyed = false, resolve = null, lastRest = false;
    el.classList.add('u-morph');
    el.dataset.tone = tone;
    el.style.width = flat ? '100%' : `${size}px`;
    el.style.height = flat ? '8px' : `${size}px`;
    if (flat) el.dataset.flat = 'true';
    if (!el.getAttribute('aria-label')) el.setAttribute('aria-hidden', 'true');
    if (tone === 'white' || tone === 'ink') el.style.color = tone === 'white' ? '#FFFFFF' : '#1C1915';
    const stops = list => list.map(([offset, color]) => `<stop offset="${offset}" stop-color="${color}"/>`).join('');
    const stroke = size <= 32 ? 15 : 9;
    el.innerHTML = `<span class="wm-rest">${staticSVG(size, { id: id + '-rest', tone })}</span><svg class="wm-live" viewBox="${flat ? '0 112 320 96' : '0 0 320 320'}" ${flat ? 'preserveAspectRatio="none"' : ''} aria-hidden="true" focusable="false"><defs><linearGradient id="${id}-a" x1="77" y1="60" x2="247" y2="269" gradientUnits="userSpaceOnUse">${stops(data.goldA)}</linearGradient><linearGradient id="${id}-b" x1="224" y1="64" x2="106" y2="272" gradientUnits="userSpaceOnUse">${stops(data.goldB)}</linearGradient></defs><g fill="none" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"><path class="wm-a" stroke="${gold ? `url(#${id}-a)` : 'currentColor'}"/><path class="wm-b" stroke="${gold ? `url(#${id}-b)` : 'currentColor'}"/></g></svg>`;
    const rest = el.querySelector('.wm-rest'), live = el.querySelector('.wm-live');
    const a = el.querySelector('.wm-a'), b = el.querySelector('.wm-b');
    function paint(frame, opacity = 0, phase = 'rest') {
        current = frame;
        currentRest = opacity;
        if (lastRest && opacity === 1) return;
        if (opacity < 1) {
            a.setAttribute('d', path(frame.pair[0]));
            b.setAttribute('d', path(frame.pair[1]));
        }
        if (rest.style.opacity !== String(opacity)) rest.style.opacity = String(opacity);
        if (live.style.opacity !== String(1 - opacity)) live.style.opacity = String(1 - opacity);
        const pose = opacity === 1 ? 'logo' : kind;
        if (el.dataset.pose !== pose) el.dataset.pose = pose;
        if (el.dataset.phase !== phase) el.dataset.phase = phase;
        lastRest = opacity === 1;
    }
    function finish() { const done = resolve; resolve = null; done?.(); }
    function cancel() { clearTimeout(pending); pending = 0; handoff = null; finish(); }
    function idle() {
        if (destroyed) return;
        cancel();
        state = 'idle';
        pausedAt = null;
        delete el.dataset.running;
        el.dataset.state = state;
        paint(model.base, 1);
        el.dispatchEvent(new Event('ensemble:morph-idle'));
        schedule();
    }
    const actor = {
        get state() { return state; },
        get visible() { return visible && el.isConnected; },
        get reduced() { return reduced; },
        nextFrame(now) {
            if (state !== 'loop' || handoff) return 0;
            const clock = model.timing(kind, (now - started) / 1000);
            return !clock.moving && !lastRest ? 0 : clock.wait * 1000;
        },
        tick(now) {
            if (destroyed) return;
            const elapsed = (now - started) / 1000;
            if (state === 'settle') {
                const amount = clamp(elapsed / BASE.settle);
                paint(model.settle(from, amount), fromRest + (1 - fromRest) * ease((amount - .65) / .35), 'return');
                if (amount >= 1) idle();
                return;
            }
            const frame = state === 'once' ? model.once(elapsed) : model.cycle(kind, elapsed);
            if (handoff) {
                const amount = ease((now - handoff.started) / SETTLE_MS);
                frame.frame = model.mixFrames(handoff.frame, frame.frame, amount);
                frame.rest = handoff.rest + (frame.rest - handoff.rest) * amount;
                if (amount === 1) handoff = null;
            }
            paint(frame.frame, frame.rest, frame.phase);
            if (state === 'once' && !frame.moving) idle();
        },
        refresh() {
            if (destroyed) return;
            const now = performance.now();
            const nextReduced = el.closest('[data-reduce-motion="true"]') !== null || !!media?.matches;
            const blocked = nextReduced || !actor.visible || document.hidden;
            const changed = nextReduced !== reduced;
            reduced = nextReduced;
            if (el.dataset.reduced !== String(reduced)) el.dataset.reduced = String(reduced);
            if (state === 'loop') {
                if (changed) { started = now; pausedAt = blocked ? now : null; handoff = null; }
                if (blocked && pausedAt === null) pausedAt = now;
                else if (!blocked && pausedAt !== null) {
                    const pause = now - pausedAt;
                    started += pause;
                    if (handoff) handoff.started += pause;
                    pausedAt = null;
                }
                if (reduced) paint(model.base, 1);
            }
            else if (blocked && (state === 'once' || state === 'settle')) idle();
            else if (reduced) paint(model.base, 1);
        },
        once() {
            if (destroyed) return Promise.resolve();
            cancel();
            kind = 'unfurl';
            actor.refresh();
            if (reduced || !actor.visible || document.hidden) { idle(); return Promise.resolve(); }
            state = 'once';
            started = performance.now();
            el.dataset.running = 'true';
            el.dataset.state = state;
            const promise = new Promise(done => { resolve = done; });
            schedule();
            return promise;
        },
        loop({ delay = 0, kind: next = defaultKind } = {}) {
            if (destroyed) return actor;
            if (!Object.hasOwn(kinds, next) || next === 'unfurl') next = 'infinity';
            if ((state === 'loop' || state === 'pending') && kind === next) {
                actor.refresh();
                schedule();
                return actor;
            }
            const previous = !reduced && currentRest < 1 ? { frame: current, rest: currentRest, started: performance.now() } : null;
            cancel();
            kind = next;
            const start = () => {
                if (destroyed) return;
                pending = 0;
                state = 'loop';
                started = performance.now();
                pausedAt = null;
                handoff = previous && delay <= 0 ? { ...previous, started } : null;
                if (handoff) started -= model.timing(kind, 0).arrive * 1000;
                el.dataset.running = 'true';
                el.dataset.state = state;
                actor.refresh();
                schedule();
            };
            if (delay > 0) {
                state = 'pending';
                delete el.dataset.running;
                el.dataset.state = state;
                paint(model.base, 1);
                pending = setTimeout(start, delay);
                schedule();
            }
            else start();
            return actor;
        },
        settle() {
            if (destroyed) return Promise.resolve();
            actor.refresh();
            if (state === 'idle' || state === 'pending' || currentRest === 1 || reduced || !actor.visible || document.hidden) {
                idle();
                return Promise.resolve();
            }
            cancel();
            from = current;
            fromRest = currentRest;
            state = 'settle';
            started = performance.now();
            el.dataset.state = state;
            const promise = new Promise(done => { resolve = done; });
            schedule();
            return promise;
        },
        idle,
        seek(mode, seconds) {
            if (destroyed) return;
            cancel();
            state = 'idle';
            kind = mode === 'once' ? 'unfurl' : defaultKind === 'unfurl' ? 'infinity' : defaultKind;
            el.dataset.state = state;
            el.dataset.running = 'true';
            actor.refresh();
            const frame = mode === 'once' ? model.once(seconds) : model.cycle(kind, seconds);
            paint(reduced ? model.base : frame.frame, reduced ? 1 : frame.rest, reduced ? 'rest' : frame.phase);
            schedule();
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            cancel();
            intersection?.disconnect();
            actors.delete(actor);
            unlisten();
            el.innerHTML = '';
            schedule();
        }
    };
    const intersection = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
        visible = entries[0].isIntersecting;
        actor.refresh();
        schedule();
    }) : null;
    actors.add(actor);
    listen();
    paint(model.base, 1);
    actor.refresh();
    intersection?.observe(el);
    return actor;
}
function autoMount(scope = document) {
    return [...scope.querySelectorAll('[data-motion-slot="brand.morph"]')].map(el => {
        const state = el.dataset.state;
        const ctl = mount(el);
        if (state === 'loop') ctl.loop({ delay: Number(el.dataset.delay) || 0 });
        else if (state === 'once') void ctl.once();
        return ctl;
    });
}
module.exports = { staticSVG, mount, autoMount, BASE, kinds };
