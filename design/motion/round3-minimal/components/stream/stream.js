(function () {
  const TEXT = "Yes. Your Thursday is free from 2 to 4 pm, so I drafted a reply to Priya offering 2:30 and attached last week's retention numbers.";
  const mk = (dot) => (sc, el) => {
    const p = el.querySelector('.st-p'), rule = el.querySelector('.st-rule'), src = el.querySelector('.st-src');
    UM.cycle(sc, async () => {
      p.innerHTML = ''; rule && rule.classList.remove('on'); src.classList.remove('on');
      const words = TEXT.split(' ').map((w) => { const s = document.createElement('span'); s.className = 'w'; s.textContent = w + ' '; p.appendChild(s); return s; });
      const caret = document.createElement('i'); caret.className = dot ? 'cd' : 'cq';
      if (sc.reduced) { words.forEach((w) => w.classList.add('on')); rule && rule.classList.add('on'); src.classList.add('on'); return; }
      await sc.wait(500);
      for (let i = 0; i < words.length; i++) {
        words[i].classList.add('on'); words[i].after(caret);
        await sc.wait(60 + (i % 5 === 4 ? 140 : 0) + Math.random() * 40);
      }
      await sc.wait(400); caret.classList.add('gone');
      rule && rule.classList.add('on'); await sc.wait(260); src.classList.add('on');
      await sc.wait(2600);
    }, 400);
  };
  UM.register('minimal-quiet', 'reply.stream', mk(false));
  UM.register('minimal-dot', 'reply.stream', mk(true));
})();
