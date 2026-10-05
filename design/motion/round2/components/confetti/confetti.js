/* 01 · Strand confetti */
U2.define('confetti', (s) => {
  const root = s.$('.cf');
  let done = 3;
  const complete = async (li, auto) => {
    const box = li.querySelector('.tie-box');
    if (box.classList.contains('on')) return;
    box.classList.add('pressing'); await s.wait(120); box.classList.remove('pressing');
    box.classList.add('on');
    const tie = U2.tie(s, box.querySelector('path'));
    li.classList.add('striking'); s.after(1300, () => li.classList.add('settled'));
    li.querySelector('.t').style.color = 'var(--faint)';
    const r = box.getBoundingClientRect(), h = s.root.getBoundingClientRect();
    s.after(160, () => U2.burst(s, s.root, r.left - h.left + 10, r.top - h.top + 10, 28));
    await s.wait(420);
    done++;
    const bead = s.$$('.cf-beads circle')[done - 1];
    if (bead) { bead.classList.add('on', 'pop'); bead.classList.remove('next'); }
    s.$('.cf-h').textContent = `${done} of 5 done`;
    const toast = s.$('.cf-toast');
    toast.textContent = '';
    toast.innerHTML = `<span class="cf-dot"></span>${done === 5 ? 'All five done. Lovely.' : `Nice. ${done} of 5 done, ${5 - done === 1 ? 'one' : 5 - done} to go.`}`;
    toast.classList.add('show');
    s.after(2200, () => toast.classList.remove('show'));
  };
  s.$$('.cf-list li').forEach((li) => li.querySelector('.tie-box').addEventListener('click', () => complete(li)));
  (async () => {
    const ptr = U2.pointer(s, s.root);
    await s.wait(500); ptr.show();
    await ptr.to(s.$('.target .tie-box'));
    await ptr.click();
    complete(s.$('.target'), true);
    await s.wait(700);
    await ptr.to([s.root.clientWidth - 40, s.root.clientHeight + 30]); ptr.hide();
  })();
});
