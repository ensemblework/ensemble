import { Icon, type IconName } from "@/components/icon";
import { LiveBoard } from "@/components/live-board";
import { Mark, Wordmark } from "@/components/mark";
import { Voices } from "@/components/voices";
import { site } from "@/lib/site";

const DAY = [
  {
    time: "08:55",
    title: "The briefing is already written",
    body: "Overnight mail and chat became proposed todos. Yesterday's design review is split into who owes what, linked to the sentence that said it.",
  },
  {
    time: "09:00",
    title: "Triage in two minutes",
    body: "Every proposal has three answers: I'll do it, Agent does it, Later. You decide. Nothing is assigned behind your back.",
  },
  {
    time: "09:05",
    title: "You code. It works next to you.",
    body: "Agent tasks move across the board: gathering context, drafting, waiting for you. Ask for help in the editor and the context is already there.",
  },
  {
    time: "11:30",
    title: "Two cards wait for you",
    body: "A reply written in your tone and a PR description in your style for that repo. Approve, edit or reject. Forty seconds.",
  },
  {
    time: "17:30",
    title: "The day closes itself",
    body: "What shipped, what slipped, and a first plan for tomorrow. Every agent action sits in an audit timeline with what it read and who approved it.",
  },
];

const FEATURES: { icon: IconName; title: string; body: string }[] = [
  { icon: "sunrise", title: "Morning briefing", body: "Mail, meetings, calendar and PRs, read before you sit down and turned into proposals you can triage." },
  { icon: "board", title: "One shared board", body: "You, Agent, Needs you. See what the agent is doing, how far it is, and what it plans next." },
  { icon: "shield", title: "Approvals first", body: "Sending, opening a PR, posting: anything that leaves the building waits for a yes from you." },
  { icon: "graph", title: "Your engineer graph", body: "People, projects, repos and preferences learned from your own work, so nobody re-types context." },
  { icon: "quill", title: "Skills in your style", body: "Versioned skills for how you write PRs, commits and replies. Edit them like any other page." },
  { icon: "chain", title: "Tamper-evident ledger", body: "A hash-chained, insert-only audit log. Every run is replayable, with its inputs and approvals." },
  { icon: "plug", title: "Context in your editor", body: "A read-only MCP bridge hands VS Code, Cursor and Copilot CLI the same briefs and skills." },
  { icon: "chip", title: "Any model, your key", body: "Gemini, OpenAI, Claude, OpenRouter, Ollama or Copilot. Keys are encrypted and never leave the runtime." },
];

const TRUST = [
  { title: "Localhost first", body: "Run the whole thing on your machine, or as a desktop app with no Docker at all." },
  { title: "Least privilege", body: "Connectors read. Writes are separate actions with a preview and a policy." },
  { title: "Human in the loop", body: "Pause the agent, reject a draft, undo its writes. Control points are part of the design, not a setting." },
  { title: "Source available", body: "Read every prompt in Settings. Read every line of the code that runs them, on GitHub." },
];

const TARGETS = [
  { from: "20 min", to: "< 3 min", label: "Morning triage" },
  { from: "~150 words", to: "0", label: "Context typed before asking for help" },
  { from: "", to: "≥ 70%", label: "Drafts accepted with minor edits at most" },
  { from: "", to: "100%", label: "Agent actions in the audit ledger" },
];

function GitHubLink({ className = "" }: { className?: string }) {
  if (!site.repoPublic) return null;
  return (
    <a className={className} href={site.repoUrl} rel="noopener">
      GitHub
    </a>
  );
}

export default function Home() {
  return (
    <>
      <div className="grain" aria-hidden="true" />
      <header className="nav">
        <a href="#top" className="nav-brand" aria-label="Ensemble home">
          <Wordmark />
        </a>
        <nav className="nav-links" aria-label="Sections">
          <a href="#why">Why</a>
          <a href="#day">A day</a>
          <a href="#features">Features</a>
          <a href="/download">Download</a>
          <a href="#trust">Trust</a>
          <GitHubLink />
        </nav>
        <a className="btn btn-small" href={site.appUrl}>
          Open the app
        </a>
      </header>

      <main id="top">
        <section className="hero">
          <div className="glow" aria-hidden="true" />
          <div className="hero-copy">
            <p className="eyebrow reveal">Source available · localhost first · your keys</p>
            <h1 className="reveal" style={{ animationDelay: "80ms" }}>
              <span className="line">You and your agent,</span>
              <em className="line">in the same key.</em>
            </h1>
            <p className="lede reveal" style={{ animationDelay: "160ms" }}>
              Ensemble is a shared workspace where an engineer and their agent see the same picture: your todos, meetings, mail,
              code and people. So it can do real work without being told the context every single time.
            </p>
            <div className="ctas reveal" style={{ animationDelay: "240ms" }}>
              <a className="btn" href={site.signupUrl}>
                Get started
                <span aria-hidden="true">→</span>
              </a>
              <a className="btn btn-ghost" href="/download">
                Download the CLI
              </a>
            </div>
          </div>
          <div className="hero-board reveal" style={{ animationDelay: "320ms" }}>
            <LiveBoard />
          </div>
          <Voices className="hero-voices" />
        </section>

        <section id="why" className="section why">
          <div className="section-head">
            <p className="eyebrow">Why</p>
            <h2>
              Chat is the wrong <em>front door.</em>
            </h2>
            <p className="section-lede">
              The context an agent needs already exists in your mail, chat, meeting notes, calendar, issues and repos. A chat box
              throws most of it away, then asks you to type it back in.
            </p>
          </div>
          <div className="compare">
            <div className="compare-col compare-before">
              <div className="compare-label">Today</div>
              <ol>
                <li>You have a goal and open a chat</li>
                <li>You type a request and lose most of the context</li>
                <li>The agent guesses the intent</li>
                <li>Wrong output. You explain again.</li>
                <li className="strike">“Forget it, I'll do it myself.”</li>
              </ol>
            </div>
            <div className="compare-col compare-after">
              <div className="compare-label">With Ensemble</div>
              <ol>
                <li>The agent read what you read, overnight</li>
                <li>It proposes the work, you assign it</li>
                <li>It drafts in your voice, with sources linked</li>
                <li>You approve at the control points</li>
                <li className="win">Chat is one input, not the interface.</li>
              </ol>
            </div>
          </div>
        </section>

        <section id="day" className="section day">
          <div className="section-head">
            <p className="eyebrow">A day with it</p>
            <h2>
              One morning, <em>two voices.</em>
            </h2>
          </div>
          <ol className="timeline">
            {DAY.map((beat) => (
              <li key={beat.time} className="beat">
                <span className="beat-time">{beat.time}</span>
                <div>
                  <h3>{beat.title}</h3>
                  <p>{beat.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section id="features" className="section">
          <div className="section-head">
            <p className="eyebrow">What's inside</p>
            <h2>
              A workspace, <em>not a chat window.</em>
            </h2>
            <p className="section-lede">
              Gmail, Google Calendar, GitHub, Slack and Linear today, read-only. Outlook and Teams are next.
            </p>
          </div>
          <div className="features">
            {FEATURES.map((f) => (
              <article key={f.title} className="feature">
                <Icon name={f.icon} />
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="section needs">
          <div className="needs-copy">
            <p className="eyebrow">Needs you</p>
            <h2>
              Every agent asks <em>in one place.</em>
            </h2>
            <p className="section-lede">
              Cursor, Claude Code and VS Code Copilot hold their permission prompts open and send them to Ensemble. Answer once,
              for the session, or always. If nobody answers, the editor asks as usual. The hook never allows on its own.
            </p>
          </div>
          <div className="prompt-card" aria-label="An example permission prompt from an editor agent">
            <div className="prompt-head">
              <Icon name="hand" />
              <span>Cursor wants to run a command</span>
              <span className="faint">service-x · just now</span>
            </div>
            <pre className="prompt-cmd">
              <code>pnpm add -w p-retry@6</code>
            </pre>
            <div className="prompt-actions">
              <span className="btn-approve">Allow once</span>
              <span>This session</span>
              <span>Always</span>
              <span className="deny">Deny…</span>
            </div>
          </div>
        </section>

        <section id="trust" className="section">
          <div className="section-head">
            <p className="eyebrow">Trustworthy by default</p>
            <h2>
              Nothing risky <em>without you.</em>
            </h2>
          </div>
          <div className="trust">
            {TRUST.map((t, i) => (
              <article key={t.title} className="trust-item">
                <span className="trust-n">0{i + 1}</span>
                <h3>{t.title}</h3>
                <p>{t.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="section targets-section">
          <div className="section-head">
            <p className="eyebrow">What we measure against</p>
            <h2>
              Targets, <em>not testimonials.</em>
            </h2>
            <p className="section-lede">Ensemble is early. These are the numbers it is built to move.</p>
          </div>
          <div className="targets">
            {TARGETS.map((t) => (
              <div key={t.label} className="target">
                <div className="target-num">
                  {t.from && <span className="target-from">{t.from}</span>}
                  {t.to}
                </div>
                <div className="target-label">{t.label}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="section final">
          <Voices className="final-voices" />
          <Mark size={44} />
          <h2>
            Bring your agent <em>into the room.</em>
          </h2>
          <p className="section-lede">Create an account, save your notes and context, and bring your own model key when you are ready to use an agent.</p>
          <div className="ctas center">
            <a className="btn" href={site.signupUrl}>
              Get started <span aria-hidden="true">→</span>
            </a>
            <GitHubLink className="btn btn-ghost" />
          </div>
        </section>
      </main>

      <footer className="footer">
        <Wordmark />
        <span className="faint">An engineer and their agent, stronger together.</span>
        <span className="footer-links">
          <a href={site.appUrl}>App</a>
          <a href="/download">Download</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <GitHubLink />
        </span>
      </footer>
    </>
  );
}
