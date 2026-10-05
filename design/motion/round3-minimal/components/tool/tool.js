(function () {
  const ROWS = [['Search Gmail', 'from:priya', '3 results', 'done'], ['Read calendar', 'Thu', 'free 2–4 pm', 'done'],
    ['Fetch Linear', 'RET-12', 'rate limited', 'failed'], ['Draft reply', '', '118 words', 'done'], ['Send email', 'to Priya', 'needs you', 'pending']];
  const Q = `<svg class="i-run" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 1 6 6"/></svg><svg class="i-done" viewBox="0 0 16 16"><path pathLength="1" d="M3.5 8.4l3 2.9 6-6.3"/></svg><svg class="i-pend" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/></svg><svg class="i-fail" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M5.5 8h5"/></svg>`;
  const D = `<i class="i-run"></i><i class="i-done"></i><i class="i-pend"></i><i class="i-fail"></i>`;
  const mk = (dot) => (sc, el) => {
    const list = el.querySelector('.tc-list');
    UM.cycle(sc, async () => {
      list.innerHTML = ROWS.map(([l, a, m]) => `<div class="tc-row" data-s="running"><span class="tc-ic">${dot ? D : Q}</span><span class="l">${l}<small>${a}</small></span><span class="m">${m}</span></div>`).join('');
      const rows = [...list.children];
      rows.forEach((r) => (r.querySelector('.m').dataset.final = r.querySelector('.m').textContent));
      if (sc.reduced) { rows.forEach((r, i) => { r.dataset.s = ROWS[i][3]; r.classList.add('on'); }); return; }
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i], m = r.querySelector('.m'); m.textContent = i === 4 ? '' : 'running';
        await sc.wait(80); r.classList.add('on');
        await sc.wait(i === 4 ? 700 : 1100 + (i === 3 ? 600 : 0));
        r.dataset.s = ROWS[i][3]; m.textContent = m.dataset.final;
        await sc.wait(200);
      }
      await sc.wait(3200);
    }, 200);
  };
  UM.register('minimal-quiet', 'tool.call', mk(false));
  UM.register('minimal-dot', 'tool.call', mk(true));
})();
