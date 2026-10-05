(function () {
  const OLD = [['Akash', 'PR #42 review requested', '9:02'], ['Calendar', 'Standup moved to 11:00', '8:40']];
  const NEW = [['Priya', 'Re: retention review', 'now'], ['Linear', 'RET-12 assigned to you', 'now'], ['Slack', '#eng: deploy is green', 'now']];
  const row = (r, n) => `<div class="fe-r${n ? ' new' : ''}"><i class="nd"></i><b>${r[0]}</b><span>${r[1]}</span><span class="m-mono">${r[2]}</span></div>`;
  const mk = (dot) => (sc, el) => {
    const list = el.querySelector('.fe-list'), lbl = el.querySelector('.fe-btn .m-swap');
    const gs = dot ? [el.querySelector('.fe-dd')] : [...el.querySelectorAll('.fe-ic g')];
    UM.cycle(sc, async () => {
      list.innerHTML = OLD.map((r) => row(r)).join(''); lbl.textContent = 'Fetch now';
      if (sc.reduced) { list.innerHTML = NEW.map((r) => row(r)).join('') + list.innerHTML; list.querySelectorAll('.new').forEach((r) => r.classList.add('on')); lbl.textContent = '3 new'; return; }
      await sc.wait(1100); UM.swap(sc, lbl, 'Fetching');
      const turns = dot ? 2 : 2, per = 1500;
      for (let k = 0; k < turns; k++) {
        await sc.tween(per, (p) => gs.forEach((g, i) => { const a = (k + p) * (dot ? 180 : 360); g.style.transform = `rotate(${a}deg)`; }), UM.drift);
      }
      NEW.slice().reverse().forEach((r) => list.insertAdjacentHTML('afterbegin', row(r, 1)));
      UM.swap(sc, lbl, '3 new');
      const ns = [...list.querySelectorAll('.new')]; for (const n of ns) { void n.offsetWidth; n.classList.add('on'); await sc.wait(90); }
      await sc.wait(3000);
    }, 200);
  };
  UM.register('minimal-quiet', 'fetch.refresh', mk(false));
  UM.register('minimal-dot', 'fetch.refresh', mk(true));
})();
