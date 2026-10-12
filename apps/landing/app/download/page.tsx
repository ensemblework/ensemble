import { CopyCode } from "@/components/copy-code";
import { DesktopDownloads } from "@/components/desktop-downloads";
import { Mark } from "@/components/mark";
import { OsInstallTabs } from "@/components/os-install-tabs";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { pageMetadata } from "@/lib/metadata";
import { afterInstallCommands, editors, HOSTED_MCP_URL, insideCommands, RELEASES_URL } from "@/lib/download";

export const dynamic = "force-static";

const TITLE = "Download Ensemble for macOS, Windows and Linux";
const DESCRIPTION =
  "The Ensemble desktop app and the ensemble terminal app for macOS, Windows and Linux. Run AI agent tasks in a sandbox on your own computer, answer them from anywhere, and connect editors over MCP.";

export const metadata = pageMetadata({ path: "/download", title: TITLE, description: DESCRIPTION });

type Segment = [className: string, text: string];

/** A still of the `ensemble` app: the Tasks tab with a question waiting. */
const TERMINAL: Segment[][] = [
  [["t-accent", " ◆ Ensemble "], ["t-tab", " Tasks · 1 needs you "], ["", "  Chat"], ["t-dim", "                    ~/code/shop-api"]],
  [["t-dim", " ──────────────────────────────┬──────────────────────────────────────────"]],
  [["t-warn", " NEEDS YOU 1"], ["t-dim", "                   │ "], ["t-warn", "◆ "], ["", "Fix the flaky checkout test"]],
  [["t-accent", " ▸ "], ["t-warn", "◆ "], ["", "Fix the flaky checkout…  2m "], ["t-dim", "│ Claude Code · Ask · may commit · sandbox on"]],
  [["t-dim", " RUNNING 1                     │"]],
  [["t-accent", "   ● "], ["", "Add rate limiting       4m "], ["t-dim", "│ "], ["t-warn", "Claude Code asks:"]],
  [["t-dim", " DONE 3                        │ "], ["", "Pin the clock with fake timers, or retry"]],
  [["t-ok", "   ✓ "], ["", "Release notes           1h "], ["t-dim", "│ "], ["", "the request twice?"]],
  [["", ""]],
  [["", " "], ["t-tab", " 1 ★ Pin the clock "], ["", "  2 Retry twice   "], ["t-warn", "3 Skip"], ["t-dim", "   or type your own answer"]],
  [["t-accent", " › "], ["t-dim", "Type your answer, or / for commands"]],
];

export default function DownloadPage() {
  return (
    <>
      <div className="grain" aria-hidden="true" />
      <SiteHeader />

      <main>
        <section className="download-hero">
          <div className="glow" aria-hidden="true" />
          <Mark size={46} />
          <p className="eyebrow">Desktop app · Terminal · MCP</p>
          <h1>
            Download Ensemble for <em>your computer.</em>
          </h1>
          <p className="lede">
            The desktop app is the easiest start. The <code>ensemble</code> command opens the same Ensemble in your terminal: your tasks, what needs you,
            and a chat with Claude Code, Codex or Cursor on your own sign-in. Both share one runtime, so install either first.
          </p>
          <div className="ctas center">
            <a className="btn" href="#desktop">
              Download the app <span aria-hidden="true">→</span>
            </a>
            <a className="btn btn-ghost" href="#install">
              Install the terminal app
            </a>
          </div>
        </section>

        <section id="desktop" className="section download-section">
          <div className="section-head">
            <p className="eyebrow">Desktop app</p>
            <h2>
              One download, <em>no setup.</em>
            </h2>
            <p className="section-lede">
              Your board, Needs me and the agents, running on your computer inside its own sandbox. Sign in when you want tasks you assign on
              ensemblework.com or from your phone to run here.
            </p>
          </div>
          <DesktopDownloads />
          <div className="download-note">
            <h3>First launch</h3>
            <p>
              The installers are not code-signed yet. On macOS, open the app once, then choose System Settings → Privacy &amp; Security →{" "}
              <em>Open Anyway</em>. On Windows, SmartScreen shows <em>More info → Run anyway</em>. On Linux, install the <code>.deb</code>, or run{" "}
              <code>chmod +x Ensemble_*.AppImage</code> and start it. Every build, with checksums, is on <a href={RELEASES_URL}>GitHub Releases</a> under
              tags starting <code>desktop-v</code>.
            </p>
          </div>
        </section>

        <section id="install" className="section download-section">
          <div className="section-head">
            <p className="eyebrow">Terminal</p>
            <h2>
              Install <code>ensemble</code>, <em>then just run it.</em>
            </h2>
            <p className="section-lede">
              Homebrew, Scoop and the scripts install the full terminal app with its own runtime. The npm package only connects editors (MCP).
            </p>
          </div>
          <OsInstallTabs />
          <div className="download-note">
            <h3>Manual downloads and checksums</h3>
            <p>
              Releases live on <a href={RELEASES_URL}>GitHub Releases</a>. Filter tags starting <code>cli-v</code>, download the archive or package for your CPU, then verify it against <code>SHA256SUMS.txt</code>.
            </p>
          </div>
        </section>

        <section className="section download-section">
          <div className="section-head">
            <p className="eyebrow">Use it</p>
            <h2>
              Open it in your project. <em>Type / for the rest.</em>
            </h2>
            <p className="section-lede">
              <code>ensemble</code> starts Ensemble on this computer if it is not running, and it keeps running your tasks after you close the terminal.{" "}
              <strong>Tasks</strong> shows runs and everything that needs you: click an answer, press its number, type your own, or use{" "}
              <code>/allow</code> and <code>/deny</code>. <strong>Chat</strong> is your agent: Claude Code, Codex or Cursor on your own sign-in, working in this folder under one of your run profiles with your Ensemble board loaded, and remembering the conversation.
              Or Ensemble Code, with a model key.
            </p>
          </div>
          <pre className="terminal-still" aria-label="The ensemble app in a terminal, with a question waiting">
            {TERMINAL.map((line, row) => (
              <span key={row}>
                {line.map(([className, text], index) => (className ? <span key={index} className={className}>{text}</span> : text))}
                {"\n"}
              </span>
            ))}
          </pre>
          <div className="download-two">
            <CopyCode label="Open it" code={afterInstallCommands.join("\n")} />
            <CopyCode label="Inside, type /" code={insideCommands.join("\n")} />
          </div>
          <div className="download-note">
            <p>
              <code>/login</code> pairs this computer with your account, so tasks you assign on ensemblework.com or from your phone run here.{" "}
              <code>/runner install</code> starts Ensemble when you log in. For scripts, every command also runs on its own:{" "}
              <code>ensemble help commands</code>.
            </p>
          </div>
        </section>

        <section id="mcp" className="section download-section">
          <div className="section-head">
            <p className="eyebrow">MCP</p>
            <h2>
              Connect your editor with <em>local or hosted MCP.</em>
            </h2>
            <p className="section-lede">
              Local MCP uses <code>ensemble mcp</code>. Hosted MCP uses <code>{HOSTED_MCP_URL}</code> with header <code>Authorization: Bearer &lt;ens_ key&gt;</code>. Keys come from the Connect page and use the read-only bridge scope.
            </p>
          </div>
          <div className="editor-list">
            {editors.map((editor) => (
              <article key={editor.id} className="editor-card">
                <div className="editor-card-head">
                  <div>
                    <h3>{editor.name}</h3>
                    {editor.note ? <p>{editor.note}</p> : null}
                  </div>
                  <code>{editor.printOnly ? `ensemble mcp setup ${editor.setupId} --print` : `ensemble mcp setup ${editor.setupId}`}</code>
                </div>
                <div className="editor-snippets">
                  <CopyCode label="Local CLI" code={editor.local} />
                  <CopyCode label="Hosted URL" code={editor.hosted} />
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="section download-section faq-section">
          <div className="section-head">
            <p className="eyebrow">FAQ</p>
            <h2>
              Requirements and <em>security.</em>
            </h2>
          </div>
          <div className="faq-grid">
            <article>
              <h3>What systems are supported?</h3>
              <p>
                macOS 13+ on Apple Silicon or Intel, Windows 10/11 x64, and Linux x64 or arm64 with glibc 2.35+ (Ubuntu 22.04+, Debian 12+, Fedora 36+). Git is
                needed for code tasks. The terminal app is about 120 MB because it carries its own Node runtime and local database.
              </p>
            </article>
            <article>
              <h3>Where do keys live?</h3>
              <p>
                Model keys you add with <code>/keys</code> or in the desktop app stay encrypted on your computer and are never sent to Ensemble. Claude Code,
                Codex and Cursor use their own sign-in. MCP is read-only: the <code>ens_</code> key the CLI or the Connect page creates can read your
                Ensemble context and cannot change anything.
              </p>
            </article>
            <article>
              <h3>Is there a sandbox? Do I need Docker?</h3>
              <p>
                No Docker, no VM. Commands run in the operating system&apos;s own sandbox: Seatbelt on macOS, bubblewrap or Landlock on Linux,
                and a separate sandbox account on Windows (set up once, with one Windows permission prompt). Writes stay in the task&apos;s folder,
                your keys and browser data stay unreadable, and the internet is off unless the task allows it.
              </p>
            </article>
            <article>
              <h3>Where can tasks run?</h3>
              <p>
                In the folder you opened <code>ensemble</code> in, or a fresh clone of a repo, inside the sandbox. Tasks from the web run only in folders you
                share with this computer. <code>/logout</code> removes this computer from your account.
              </p>
            </article>
            <article>
              <h3>Will macOS or Windows warn about unsigned builds?</h3>
              <p>
                The desktop installers do, once (see First launch above). The terminal app does not when installed with Homebrew, Scoop, the install
                scripts or the Linux packages; a zip you download by hand may need “Open anyway” or “Run anyway” once.
              </p>
            </article>
            <article>
              <h3>Desktop app or terminal?</h3>
              <p>
                Either, or both. They share one runtime on a computer: one database, one pairing, one list of trusted folders, one sandbox. A task started
                in one shows up in the other, and either can answer what it asks.
              </p>
            </article>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
