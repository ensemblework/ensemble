/* EnsembleStream: append model deltas as .u-tok spans ahead of the needle. */
window.EnsembleStream = {
  start(reply) { reply.classList.add("is-streaming"); reply.classList.remove("is-done");
    const body = reply.querySelector(".u-reply-body"); body.innerHTML = '<span class="u-needle" aria-hidden="true"></span>'; },
  append(reply, text) { const n = reply.querySelector(".u-needle"); const s = document.createElement("span");
    s.className = "u-tok"; s.textContent = text; n.before(s); },
  done(reply) { reply.classList.remove("is-streaming"); reply.classList.add("is-done"); },
};
