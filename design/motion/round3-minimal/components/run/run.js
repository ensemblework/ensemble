(function () {
  const STEPS = ['Collecting sources', 'Reading 14 threads', 'Summarizing', 'Writing the digest', 'Delivering'];
  const mk = (dot) => (sc, el) => {
    const root = el.querySelector('.rp'), step = el.querySelector('.rp-step'), pc = el.querySelector('.rp-pc'), elp = el.querySelector('.rp-el');
    const fill = el.querySelector('.rp-fill'), head = el.querySelector('.rp-head'), track = el.querySelector('.rp-track'), dots = [...el.querySelectorAll('.rp-dots i')];
    let v = 0;
    const set = (x) => { v = x; pc.textContent = Math.round(x * 100) + '%'; if (!dot) { fill.style.transform = `scaleX(${x})`; head.style.transform = `translateX(${x * track.clientWidth}px)`; } };
    const mark = (k) => dots.forEach((d, i) => { d.className = i < k ? 'done' : i === k ? 'cur' : ''; });
    let t = 0; sc.loop((dt) => { t += dt; elp.textContent = '0:' + String(Math.floor(t * 3) % 60).padStart(2, '0'); });
    UM.cycle(sc, async () => {
      root.classList.remove('fin'); set(0); mark(-1); step.textContent = 'Queued'; t = 0;
      if (sc.reduced) { set(.6); mark(3); step.textContent = STEPS[3]; return; }
      await sc.wait(900);
      for (let k = 0; k < STEPS.length; k++) {
        mark(k); UM.swap(sc, step, STEPS[k]);
        const a = v, b = (k + 1) / STEPS.length;
        await sc.tween(1300, (p) => set(a + (b - a) * p), UM.calm); await sc.wait(250);
      }
      mark(5); root.classList.add('fin'); await UM.swap(sc, step, 'Delivered to #eng · 42s'); await sc.wait(2600);
    }, 300);
  };
  UM.register('minimal-quiet', 'run.progress', mk(false));
  UM.register('minimal-dot', 'run.progress', mk(true));
})();
