(function () {
  const LINES = ['Thinking', 'Reading 3 threads from Priya', 'Checking your calendar', 'Drafting a reply'];
  const run = (sc, el) => {
    const txt = el.querySelector('.th-txt'), t = el.querySelector('.th-t');
    let s = 0; if (!sc.reduced) sc.loop((dt) => { s += dt; t.textContent = Math.floor(s) + 's'; });
    else { t.textContent = '12s'; txt.textContent = LINES[1]; return; }
    let i = 0;
    UM.cycle(sc, async () => { await sc.wait(2600); i = (i + 1) % LINES.length; if (i === 0) s = 0; await UM.swap(sc, txt, LINES[i]); }, 0);
  };
  UM.register('minimal-quiet', 'agent.thinking', run);
  UM.register('minimal-dot', 'agent.thinking', run);
})();
