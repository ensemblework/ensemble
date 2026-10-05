/* Demo orchestration only. The motion system lives in components/. */
(function () {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const G = window.EnsembleGlyph;
  if (new URLSearchParams(location.search).has("reduced")) document.documentElement.dataset.reduceMotion = "true";
  G.auto();

  // TOC
  $$(".sec").forEach((s) => { const a = document.createElement("a"); a.href = "#" + s.id; a.textContent = s.dataset.title; $("#toc").append(a); });

  // 01 hero glyph + states
  const hero = G.mount($("#hero-glyph"), { size: 128, state: "working" });
  [["working", "Working"], ["wait", "Waiting on you"], ["pause", "Paused"], ["success", "Done"], ["error", "Error"], ["idle", "Idle"]].forEach(([s, l]) => {
    const b = document.createElement("button"); b.className = "btn"; b.textContent = l; b.dataset.s = s;
    b.onclick = () => { hero.set(s); $$("#glyph-states .btn").forEach((x) => x.setAttribute("aria-pressed", x === b)); };
    if (s === "working") b.setAttribute("aria-pressed", "true");
    $("#glyph-states").append(b);
  });
  EnsembleStatus.mount($("#hero-status"), { elapsed: 12, tokens: 1240 });
  EnsembleStatus.mount($("#light-status"), { elapsed: 3 });
  $("#smil-img").src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(window.ENSEMBLE_GLYPH_SMIL);
  Object.keys(ENSEMBLE_GLYPH_KF).forEach((k) => {
    const s = document.createElement("div"); s.className = "s"; s.innerHTML = `<div class="bx"><span></span></div>${k}`; $("#strip").append(s);
    const g = G.mount(s.querySelector("span"), { size: 40, state: "idle" }); cancelAnimationFrame(g.raf);
    g.el.className = "u-glyph"; g.render(ENSEMBLE_GLYPH_KF[k], 0, 1, null, { spark: [0.55, 0.62], braid: [0.8, 0.85] }[k] || [1, 1]);
  });
  $("#verbs").textContent = EnsembleStatus.VERBS.map((v) => v + "…").join("  ·  ");

  // 02 splash
  function splash() {
    const host = $("#splash-host");
    host.innerHTML = `<div class="u-splash"><div style="width:150px;height:150px">${window.ENSEMBLE_SPLASH_SVG.replace('width="240" height="240"', 'width="150" height="150"')}</div><div class="word">Ensemble</div><div class="st"></div></div>`;
    const st = EnsembleStatus.mount(host.querySelector(".st"), { verbs: ["Tuning in", "Warming up", "Finding the thread"], hint: "" });
    setTimeout(() => st.setReal("Connecting to hub-api…"), 2600);
    setTimeout(() => { host.querySelector(".u-splash").classList.add("is-ready"); }, 3900);
    setTimeout(() => { host.innerHTML = `<div class="faint small">Shell ready → Today</div>`; st.destroy(); }, 4400);
  }
  $("#splash-replay").onclick = splash; splash(); setInterval(splash, 5600);

  // 03 route transitions
  const PAGES = {
    today: { t: "Today", skel: () => skelToday(), html: () => `<div class="u-rise pg-title" style="--i:0">Good morning, Shivani</div><div class="u-title-thread"></div>
      ${["Reply to Priya about the retention window", "Review PR #42: context pack ranking", "Prep notes for the 16:00 sync"].map((t, i) => `<div class="u-rise card row" style="--i:${i + 1};margin-top:8px"><span class="kdot" style="background:var(--kind-task)"></span><span style="flex:1">${t}</span><span class="tag ${["t-orange", "t-blue", "t-gray"][i]}">${["Proposed", "In progress", "To do"][i]}</span></div>`).join("")}` },
    board: { t: "Task board", skel: () => skelBoard(), html: () => `<div class="u-rise pg-title" style="--i:0">Board</div><div class="u-title-thread"></div><div class="row" style="align-items:flex-start;gap:10px">
      ${["Proposed", "To do", "In progress", "Waiting for me"].map((c, i) => `<div class="u-rise" style="--i:${i + 1};flex:1"><div class="small faint" style="margin-bottom:6px">${c}</div>${Array.from({ length: 3 - (i % 2) }, (_, k) => `<div class="card" style="margin-bottom:6px;height:${34 + ((k + i) % 2) * 14}px"><span class="kdot" style="display:inline-block;background:var(--kind-task)"></span> Task ${i * 3 + k + 1}</div>`).join("")}</div>`).join("")}</div>` },
    context: { t: "Context", skel: () => `<div class="u-skel line" style="width:30%;height:16px"></div><div style="margin-top:16px;display:grid;place-items:center">${window.ENSEMBLE_GRAPH_SVG}</div>`,
      html: () => `<div class="u-rise pg-title" style="--i:0">Context</div><div class="u-title-thread"></div><div class="u-rise" style="--i:1;display:grid;place-items:center">${graphReal()}</div>` },
    runs: { t: "Runs", skel: () => skelRuns(), html: () => `<div class="u-rise pg-title" style="--i:0">Runs</div><div class="u-title-thread"></div>${["Fix flaky retention job test", "Draft weekly recap", "Summarise design review"].map((t, i) => `<div class="u-rise card row" style="--i:${i + 1};margin-top:8px"><span class="tag ${["t-blue", "t-green", "t-green"][i]}">${["Working", "Done", "Done"][i]}</span><span style="flex:1">${t}</span><span class="faint small mono">${["41s", "2m 3s", "58s"][i]}</span></div>`).join("")}` },
  };
  function graphReal() {
    const hub = [160, 100], n = [[60, 50, "people"], [70, 150, "repo"], [250, 45, "project"], [270, 140, "task"], [160, 20, "skill"], [165, 180, "people"], [40, 100, "project"], [290, 90, "repo"]];
    return `<svg viewBox="0 0 320 200" width="320" height="200">${n.map(([x, y]) => `<path d="M160 100 Q${(160 + x) / 2} ${(100 + y) / 2 - 12} ${x} ${y}" stroke="var(--line-strong)" stroke-width="1.5" fill="none"/>`).join("")}
      <circle cx="160" cy="100" r="14" fill="var(--accent)"/>${n.map(([x, y, k]) => `<circle cx="${x}" cy="${y}" r="8" fill="var(--kind-${k})"/>`).join("")}</svg>`;
  }
  const skl = (w, h, i, extra = "") => `<div class="u-skel" style="--i:${i};width:${w};height:${h}px;${extra}"></div>`;
  function skelToday() { return skl("45%", 20, 0) + `<div style="height:14px"></div>` + [1, 2, 3].map((i) => skl("100%", 34, i, "margin-top:8px")).join(""); }
  function skelBoard() { return skl("25%", 20, 0) + `<div class="row" style="align-items:flex-start;gap:10px;margin-top:16px">` + [0, 1, 2, 3].map((c) => `<div style="flex:1">${skl("50%", 9, c)}${[0, 1, 2].slice(0, 3 - (c % 2)).map((k) => skl("100%", 34 + ((k + c) % 2) * 14, c + k + 1, "margin-top:8px")).join("")}</div>`).join("") + `</div>`; }
  function skelRuns() { return skl("20%", 20, 0) + [1, 2, 3].map((i) => `<div class="row" style="margin-top:10px">${skl("56px", 18, i)}${skl("100%", 18, i + 1)}</div>`).join(""); }
  const order = ["today", "board", "context", "runs"]; let ri = 0;
  async function go(name) {
    const page = $("#route-page"), prog = $("#route-prog"), P = PAGES[name];
    $$("#route-app .nav").forEach((n) => n.classList.toggle("on", n.dataset.r === name));
    $("#route-title").textContent = P.t;
    page.classList.remove("u-page-enter"); page.classList.add("u-page-leave");
    EnsembleProgress.start(prog);
    await wait(150);
    page.classList.remove("u-page-leave"); page.innerHTML = P.skel();
    await wait(1300);
    EnsembleProgress.done(prog);
    page.innerHTML = P.html(); page.classList.add("u-page-enter");
  }
  $$("#route-app .nav[data-r]").forEach((n) => (n.onclick = () => PAGES[n.dataset.r] && go(n.dataset.r)));
  go("today"); setInterval(() => { ri = (ri + 1) % order.length; go(order[ri]); }, 3600);

  // 04 skeleton gallery
  function gallery(el) {
    el.innerHTML = [
      ["Today", skelToday()], ["Board", skelBoard()],
      ["Context graph", `<div style="display:grid;place-items:center">${window.ENSEMBLE_GRAPH_SVG.replace('width="320" height="200"', 'width="100%" height="150"')}</div>`], ["Runs", skelRuns()],
    ].map(([t, h]) => `<div class="mock" style="height:230px;overflow:hidden"><div class="cap">${t}</div>${h}</div>`).join("");
  }
  gallery($("#skel-dark")); gallery($("#skel-light"));

  // 05 assistant dock loop
  const dockGlyph = G.mount($("#dock-glyph"), { size: 16, state: "idle" });
  const ANSWER = "Two things need you today. Priya is waiting on the retention window (she asked for 30 days, not 45). PR #42 is ready for review. I can take the recap draft and the deliverables update, and I've put both on the board as mine.";
  async function dockLoop() {
    const b = $("#dock-body");
    for (;;) {
      b.innerHTML = `<div class="umsg">What needs me today, and what can you take?</div><div class="st"></div>`;
      dockGlyph.set("working"); $("#dock-send").textContent = "Stop";
      const st = EnsembleStatus.mount(b.querySelector(".st"), { elapsed: 0 });
      await wait(2800); st.setReal("Reading Gmail…"); await wait(1300);
      const tool = document.createElement("div"); tool.className = "u-stitch tool";
      tool.innerHTML = `<svg class="seam"><rect/></svg><span class="u-duet" style="--s:12px"><i></i><i></i></span><span class="n">hub_list_tasks</span><span class="muted">Reading your board…</span>`;
      b.querySelector(".st").before(tool); st.setReal("Checking the board…"); await wait(1500);
      tool.classList.add("is-done"); tool.querySelector(".u-duet").outerHTML = `<span style="color:var(--ok)">✓</span>`;
      tool.querySelector(".muted").textContent = "Read 14 tasks"; st.setReal(null); await wait(900);
      const r = document.createElement("div"); r.className = "u-reply"; r.innerHTML = `<div class="u-reply-rule"></div><div class="u-reply-body"></div>`;
      b.querySelector(".st").before(r); EnsembleStream.start(r);
      const words = ANSWER.split(/(?<= )/);
      for (let i = 0; i < words.length; i += 2) { EnsembleStream.append(r, words.slice(i, i + 2).join("")); st.addTokens(9); await wait(85); }
      EnsembleStream.done(r); st.destroy(); b.querySelector(".st").innerHTML = `<span class="faint small">gemini-3.5-flash-lite · 7.4s</span>`;
      dockGlyph.set("success"); $("#dock-send").textContent = "↑"; await wait(1000); dockGlyph.set("idle"); await wait(2400);
    }
  }
  dockLoop();

  // 06 terminal
  EnsembleTermGlyph.mount($("#tg1"), { text: "Waiting for your decision in Ensemble → Needs me…", hint: "falls back to Cursor in 9:41" });
  EnsembleTermGlyph.mount($("#tg2"), { hint: "esc to interrupt" });

  // 07 loom run
  const loom = $("#loom"); let done = 1, t0 = Date.now();
  const steps = $$("#loom li");
  function paintSteps() { steps.forEach((li, i) => { li.className = i < done ? "done" : i === done ? "now" : ""; }); loom.style.setProperty("--done", done); }
  function tl() { $("#timeline").innerHTML = ["Prepared folder · sandboxed", "Read 6 files", "Edited retention.test.ts", "$ pnpm test → running", "Review"].map((t, i) =>
    `<div class="row" style="gap:8px;opacity:${i > done ? .45 : 1}"><span style="width:8px;height:8px;border-radius:50%;background:${i < done ? "var(--accent)" : i === done ? "var(--accent-hi)" : "var(--line-strong)"};${i === done ? "animation:u-ping 1.6s ease-out infinite" : ""}"></span><span class="${i === done ? "" : "muted"}">${t}</span>${i === done ? '<span class="u-duet" style="--s:11px;margin-left:auto"><i></i><i></i></span>' : ""}</div>`).join(""); }
  paintSteps(); tl();
  let runTimer = setInterval(() => { done++; if (done > 4) { loom.classList.add("is-done"); $("#job-tag").className = "tag t-green"; $("#job-tag").textContent = "Done"; clearInterval(runTimer); setTimeout(resetRun, 1800); } paintSteps(); tl(); }, 1700);
  function resetRun() { loom.className = "u-loom"; done = 1; $("#job-tag").className = "tag t-blue"; $("#job-tag").textContent = "Working"; paintSteps(); tl();
    clearInterval(runTimer); runTimer = setInterval(() => { done++; if (done > 4) { loom.classList.add("is-done"); $("#job-tag").className = "tag t-green"; $("#job-tag").textContent = "Done"; clearInterval(runTimer); setTimeout(resetRun, 1800); } paintSteps(); tl(); }, 1700); }
  $("#run-stop").onclick = () => { clearInterval(runTimer); loom.classList.add("is-cut"); $("#job-tag").className = "tag t-gray"; $("#job-tag").textContent = "Stopped"; setTimeout(resetRun, 2200); };
  window.__runStop = $("#run-stop").onclick;

  // 08 needs me loop
  async function needsLoop() {
    for (;;) {
      $("#needs-list").innerHTML = `<div class="u-collapse" id="dc"><div><div class="mock u-yourturn" style="padding:14px 16px 16px">
        <div class="row" style="gap:10px"><span data-u-glyph="wait" data-size="22"></span><b style="flex:1">Cursor wants to run a command</b><span class="tag t-orange">Needs you</span></div>
        <div class="mono small" style="margin:10px 0;padding:8px 10px;border-radius:8px;background:var(--raised)">pnpm --filter hub-api test -- retention</div>
        <div class="row"><button class="btn-primary u-approve" id="ap"><span class="lbl">Allow once</span><svg class="tick" viewBox="0 0 16 16"><path pathLength="1" d="M3 8.5 6.5 12 13 4.5"/></svg>${[0, 60, 120, 180, 240, 300].map((a) => `<i class="spark" style="--a:${a}deg"></i>`).join("")}</button>
          <button class="btn">Allow for session</button><button class="btn">Always</button><button class="btn-ghost">Deny</button><span class="faint small" style="margin-left:auto">falls back to Cursor in 10 min</span></div>
        <div class="u-timeout" style="--timeout:14s"></div></div></div></div>
        <div class="mock u-yourturn" style="opacity:.8"><div class="row" style="gap:10px"><span data-u-glyph="wait" data-size="22"></span><span style="flex:1">Send reply to Priya? <span class="faint">(preview ready)</span></span><span class="tag t-orange">Needs you</span></div></div>`;
      G.auto($("#needs-list"));
      await wait(4600);
      $("#ap").classList.add("is-done"); $("#dc").classList.add("is-gone");
      await wait(1900);
    }
  }
  needsLoop();

  // 09 sync
  const SRC = [["Gmail", "var(--kind-people)"], ["Calendar", "var(--kind-project)"], ["GitHub", "var(--kind-repo)"], ["Slack", "var(--kind-skill)"], ["Linear", "var(--kind-deliverable, #c9a4e0)"]];
  function srcRows(state) { $("#srcs").innerHTML = SRC.map(([n, c], i) => { const s = state(i); return `<div class="u-src is-${s}" style="--src:${c}"><span class="kdot" style="background:${c}"></span><span style="width:70px;color:var(--ink)">${n}</span><span class="u-src-line"></span><span>${{ syncing: "Syncing…", done: "Synced · just now", error: "Token expired · Reconnect" }[s]}</span></div>`; }).join(""); }
  async function fetchLoop() {
    const f = $("#fetch");
    for (;;) {
      f.className = "btn-ghost u-fetch is-busy"; $("#fetch-l").innerHTML = "Fetching…"; srcRows(() => "syncing");
      for (let i = 0; i < 5; i++) { await wait(520); srcRows((k) => (k <= i ? (k === 4 ? "error" : "done") : "syncing")); }
      f.className = "btn-ghost u-fetch is-done"; $("#fetch-l").innerHTML = `Fetch now<span class="u-count">+3 proposed</span>`;
      await wait(2600);
    }
  }
  fetchLoop();

  // 10 ask
  async function askLoop() {
    const q = "Who is waiting on me?";
    for (;;) {
      $("#ask-a").style.display = "none"; $("#ask").className = "u-ask"; $("#ask-s").innerHTML = ""; $("#ask-q").className = "faint"; $("#ask-q").textContent = "Ask Ensemble";
      await wait(700); $("#ask-q").className = "";
      for (let i = 1; i <= q.length; i++) { $("#ask-q").textContent = q.slice(0, i); await wait(40); }
      await wait(250); $("#ask").classList.add("is-asking");
      EnsembleStatus.mount($("#ask-s"), { verbs: ["Looking through your data", "Cross-referencing", "Finding the thread"], hint: "" });
      await wait(2400); $("#ask-s").__status.destroy(); $("#ask-s").innerHTML = ""; $("#ask").classList.remove("is-asking");
      $("#ask-a").style.display = "block";
      $("#ask-a").innerHTML = `<div class="u-cascade"><p style="margin:0 0 6px;font-size:13px;--i:0">Priya (retention window) and Arjun (PR #42 review). Both asked yesterday.</p>
        <div class="sources"><a style="--i:1">Re: retention window<small>Gmail · Priya · "can we keep 30 days?"</small></a><a style="--i:2">PR #42: context pack ranking<small>GitHub · review requested</small></a></div></div>`;
      $$("#ask-a .sources a").forEach((a) => (a.style.animation = `u-rise .42s var(--ease) ${a.style.getPropertyValue("--i") * 90}ms both`));
      await wait(3200);
    }
  }
  askLoop();

  // 11 kill switch
  const kg = G.mount($("#kill-glyph"), { size: 22, state: "working" });
  let paused = false;
  function kill() {
    paused = !paused;
    $("#kill-stage").classList.toggle("is-paused", paused);
    $("#kill-rows").classList.toggle("u-frozen", paused);
    kg.set(paused ? "pause" : "working");
    $("#kill-label").textContent = paused ? "Paused" : "Working · 2";
    $("#kill-label").style.color = paused ? "var(--danger)" : "";
    $("#kill").textContent = paused ? "▶ Resume" : "❚❚ Pause (kill switch)";
  }
  $("#kill").onclick = kill; setInterval(kill, 3200);
  // re-trigger the toasts' outcome morphs now and then
  setInterval(() => $$("#s-kill .u-toast .u-glyph").forEach((el) => { const s = el.__glyph.state; el.__glyph.set("working"); setTimeout(() => el.__glyph.set(s), 1400); }), 4200);

  // 12 small moments
  const sv = $("#save");
  setInterval(() => { sv.className = "u-save is-saving"; $("#save-l").textContent = "Saving…"; setTimeout(() => { sv.className = "u-save is-saved"; $("#save-l").textContent = "Saved"; }, 1700); }, 3400);
  sv.className = "u-save is-saving";
  const ho = $("#handoff"); setInterval(() => { ho.classList.toggle("to-agent"); $("#handoff-l").innerHTML = ho.classList.contains("to-agent") ? "Agent does it · assigned" : 'Triage: <span class="kbd">a</span> Agent does it'; }, 2200);

  // reduced-motion toggle (mirrors the app's data-reduce-motion setting)
  if (document.documentElement.dataset.reduceMotion === "true") $("#rm").setAttribute("aria-pressed", "true");
  $("#rm").onclick = () => {
    const on = document.documentElement.dataset.reduceMotion !== "true";
    document.documentElement.dataset.reduceMotion = on; $("#rm").setAttribute("aria-pressed", on);
    $$(".u-glyph").forEach((el) => el.__glyph && el.__glyph.set(el.__glyph.state));
  };

  // tour (used for the video): scroll section by section
  async function tour() {
    document.body.classList.add("touring");
    const secs = $$(".sec");
    $("#tour-l").textContent = "Ensemble · motion system"; window.scrollTo({ top: 0 }); await wait(1800);
    for (const s of secs) {
      $("#tour-l").textContent = s.querySelector(".num").textContent + " · " + s.dataset.title;
      s.scrollIntoView({ behavior: "smooth", block: "start" });
      if (s.id === "s-run") setTimeout(() => window.__runStop(), 1500);
      await wait(+new URLSearchParams(location.search).get("dwell") || 2800);
    }
    document.body.classList.remove("touring");
    window.__tourDone = true;
  }
  $("#tour").onclick = tour;
  if (new URLSearchParams(location.search).has("tour")) setTimeout(tour, 600);
})();
