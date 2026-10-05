/* Minimal tray / menu-bar icons (round 5 brand fix). EVERY state shows the Two-voices mark: the same hand-hinted 22 px glyph
   as the round-4 tray set (outer width 3, gap 1, inner width 2, whole-pixel arms, butt caps). Agent = outer (accent), you = inner (ink).
   Quiet signals state with hairline cues, Dot with dots. The mark itself never changes shape between styles.
   UM.trayIcon(flavour, state, {tpl, inline, ink, accent, err, size}) -> SVG string. Used by tools/gen_tray.js too. */
(function (root) {
  const UM = (root.UM = root.UM || {});
  const STATES = ['idle', 'working', 'syncing', 'needs', 'paused', 'done', 'error', 'offline'];
  const O = 'M4.5 2V11a6.5 6.5 0 0 0 13 0V2', I = 'M8 2V11a3 3 0 0 0 6 0V2';
  let uid = 0;
  const u = (o = {}) => `<g${o.mask ? ` mask="url(#${o.mask})"` : ''}${o.op ? ` opacity="${o.op}"` : ''}>` +
    `<path class="${o.oc || 'ac'}" stroke-width="3" d="${O}"${o.od ? ` stroke-dasharray="${o.od}" stroke-linecap="round"` : ''}/>` +
    `<path class="${o.ic || 'yo'}" stroke-width="2" d="${I}"${o.id ? ` stroke-dasharray="${o.id}" stroke-linecap="round"` : ''}${o.iop ? ` opacity="${o.iop}"` : ''}/></g>`;
  const badgeMask = (id) => `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="22" height="22"><rect width="22" height="22" fill="#fff"/><circle cx="18.6" cy="3.6" r="3.9" fill="#000"/></mask>`;
  const partMask = (id) => `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="22" height="22"><rect width="22" height="22" fill="#fff"/><rect x="9.5" y="12" width="3" height="9" fill="#000"/></mask>`;
  const quiet = {
    idle: () => u(),
    working: () => u({ iop: '.35' }) + `<path class="ac tw" pathLength="1" stroke-width="2" d="${I}"/>`,
    syncing: () => u({ oc: 'ac ts2', od: '2.2 1.4' }),
    needs: (m) => `<defs>${badgeMask(m)}</defs>` + u({ mask: m }) + `<circle class="acf tb" cx="18.6" cy="3.6" r="2.4" stroke="none"/>`,
    paused: (m) => `<defs>${partMask(m)}</defs>` + u({ mask: m }),
    done: (m) => `<defs>${badgeMask(m)}</defs>` + u({ mask: m }) + `<path class="ac" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M16.6 3.7l1.4 1.4 2.6-2.8"/>`,
    error: (m) => `<defs>${partMask(m)}</defs>` + u({ mask: m, oc: 'er' }),
    offline: () => u({ op: '.5', od: '0 2.6', id: '0 2.6' }),
  };
  const dot = {
    idle: () => u(),
    working: () => u({ id: '0 2.4' }),                       // you waits as a dotted strand, the agent strand stays solid
    syncing: () => u({ oc: 'ac tb', od: '0 3.2' }),
    needs: (m) => `<defs>${badgeMask(m)}</defs>` + u({ mask: m }) + `<circle class="acf" cx="18.6" cy="3.6" r="2.6" stroke="none"/>`,
    paused: (m) => `<defs>${partMask(m)}</defs>` + u({ mask: m }) + `<circle class="yf" cx="11" cy="20" r="1.2" stroke="none"/>`,
    done: (m) => `<defs>${badgeMask(m)}</defs>` + u({ mask: m }) + `<circle class="acf tb" cx="18.6" cy="3.6" r="2.6" stroke="none"/><circle class="yf" cx="18.6" cy="3.6" r="1" stroke="none"/>`,
    error: (m) => `<defs>${badgeMask(m)}</defs>` + u({ mask: m }) + `<circle class="erf" cx="18.6" cy="3.6" r="2.6" stroke="none"/>`,
    offline: () => u({ op: '.5', od: '0 3', id: '0 3' }),
  };
  UM.trayIcon = (fl, st, o = {}) => {
    const m = `mt-m${++uid}`;
    const body = (fl === 'dot' ? dot : quiet)[st](m);
    const ink = o.ink || 'currentColor', ac = o.tpl ? ink : (o.accent || 'var(--agent, var(--accent))'), er = o.tpl ? ink : (o.err || 'var(--err)');
    const style = o.inline ? `<style>.ac{stroke:${ac}}.acf{fill:${ac}}.yo{stroke:${ink}}.yf{fill:${ink}}.er{stroke:${er}}.erf{fill:${er}}</style>`
      : `<style>.mt .ac{stroke:${ac}}.mt .acf{fill:${ac}}.mt .yo{stroke:${ink}}.mt .yf{fill:${ink}}.mt .er{stroke:${er}}.mt .erf{fill:${er}}</style>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22" width="${o.size || 22}" height="${o.size || 22}" class="mt mt-${fl} mt-${st}" fill="none" stroke="${ink}" stroke-linecap="butt" stroke-linejoin="round">${style}${body}</svg>`;
  };
  UM.TRAY_STATES = STATES;
  if (typeof module !== 'undefined') module.exports = UM;
  if (!root.document) return;
  const LABEL = { idle: 'Idle', working: 'Working', syncing: 'Syncing', needs: 'Needs you', paused: 'Paused', done: 'Done', error: 'Error', offline: 'Offline' };
  const mk = (fl) => (sc, el) => {
    const grid = el.querySelector('.tr-grid'), live = el.querySelector('.tr-live'), lab = el.querySelector('.tr-lab');
    grid.innerHTML = STATES.map((s) => `<div class="tr-c"><div class="tr-big">${UM.trayIcon(fl, s, { size: 44 })}</div><div class="tr-sm">${UM.trayIcon(fl, s, { size: 22 })}${UM.trayIcon(fl, s, { size: 16 })}</div><span>${LABEL[s]}</span></div>`).join('');
    let k = 1;
    const show = (s) => { live.innerHTML = UM.trayIcon(fl, s, { size: 18 }); lab.textContent = LABEL[s]; };
    show(STATES[k]);
    if (sc.reduced) return;
    const cells = [...grid.children]; cells[k].classList.add('on');
    UM.cycle(sc, async () => { await sc.wait(2600); cells[k].classList.remove('on'); k = (k + 1) % STATES.length; cells[k].classList.add('on'); show(STATES[k]); }, 0);
  };
  if (UM.register) { UM.register('minimal-quiet', 'native.tray', mk('quiet')); UM.register('minimal-dot', 'native.tray', mk('dot')); }
})(typeof window !== 'undefined' ? window : globalThis);
