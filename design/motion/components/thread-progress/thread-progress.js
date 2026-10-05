/* EnsembleProgress: trickles toward 90% while a route loads, then completes. */
window.EnsembleProgress = {
  start(el) { el.className = "u-progress"; el.style.setProperty("--p", 0); let p = 0.08;
    requestAnimationFrame(() => el.style.setProperty("--p", p));
    clearInterval(el.__t); el.__t = setInterval(() => { p += (0.9 - p) * 0.18; el.style.setProperty("--p", p.toFixed(3)); }, 260); },
  done(el) { clearInterval(el.__t); el.style.setProperty("--p", 1); setTimeout(() => el.classList.add("is-done"), 420);
    setTimeout(() => el.classList.add("is-idle"), 1100); },
};
