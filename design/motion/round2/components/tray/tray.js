/* 15 · Tray: the live icons in the two menu bars cycle through the states. */
U2.define('tray', (s) => {
  const ORDER = [['working', 'Working'], ['syncing', 'Syncing'], ['needs', 'Needs you'], ['listening', 'Listening'], ['done', 'Done'], ['paused', 'Paused'], ['error', 'Error'], ['offline', 'Offline'], ['idle', 'Idle']];
  const lives = s.$$('.tr-cyc'), labels = s.$$('.tr-state');
  let i = 0;
  const set = (k) => { const [st, name] = ORDER[k % ORDER.length]; lives.forEach((svg) => { ORDER.forEach(([o]) => svg.classList.remove(o)); svg.classList.add(st); }); labels.forEach((l) => (l.textContent = name)); };
  set(0);
  if (s.reduced) return;
  const tick = () => { i++; set(i); s.after(1500, tick); };
  s.after(1500, tick);
});
