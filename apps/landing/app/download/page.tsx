import type { Metadata } from "next";
import { CopyCode } from "@/components/copy-code";
import { Mark, Wordmark } from "@/components/mark";
import { OsInstallTabs } from "@/components/os-install-tabs";
import { afterInstallCommands, editors, HOSTED_MCP_URL, RELEASES_URL } from "@/lib/download";
import { site } from "@/lib/site";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Download the Ensemble CLI",
  description: "Install the Ensemble CLI, run tasks on your computer, and connect editors to Ensemble over MCP.",
  alternates: { canonical: "/download" },
  openGraph: {
    title: "Download the Ensemble CLI",
    description: "Install the Ensemble CLI, run tasks on your computer, and connect editors to Ensemble over MCP.",
    url: `${site.url}/download`,
  },
};

export default function DownloadPage() {
  return (
    <>
      <div className="grain" aria-hidden="true" />
      <header className="nav">
        <a href="/" className="nav-brand" aria-label="Ensemble home">
          <Wordmark />
        </a>
        <nav className="nav-links" aria-label="Sections">
          <a href="/#why">Why</a>
          <a href="/#features">Features</a>
          <a href="/download">Download</a>
          <a href="/#trust">Trust</a>
          <a href={site.repoUrl} rel="noopener">
            GitHub
          </a>
        </nav>
        <a className="btn btn-small" href={site.appUrl}>
          Open the app
        </a>
      </header>

      <main>
        <section className="download-hero">
          <div className="glow" aria-hidden="true" />
          <Mark size={46} />
          <p className="eyebrow">Ensemble CLI + MCP</p>
          <h1>
            Download Ensemble for <em>your computer.</em>
          </h1>
          <p className="lede">
            Install the CLI to sign in, share folders, run assigned tasks, and let your editor read Ensemble through MCP. Prefer no install? Use the hosted MCP URL with a read-only key.
          </p>
          <div className="ctas center">
            <a className="btn" href="#install">
              Install the CLI <span aria-hidden="true">→</span>
            </a>
            <a className="btn btn-ghost" href="#mcp">
              Connect an editor
            </a>
          </div>
        </section>

        <section id="install" className="section download-section">
          <div className="section-head">
            <p className="eyebrow">Install</p>
            <h2>
              Pick the channel that fits <em>your OS.</em>
            </h2>
            <p className="section-lede">
              Homebrew, Scoop and the scripts install the full CLI and runner. The npm package is for login and MCP only.
            </p>
          </div>
          <OsInstallTabs />
          <div className="download-note">
            <h3>Manual downloads and checksums</h3>
            <p>
              Releases live on <a href={RELEASES_URL}>GitHub Releases</a>. Filter tags starting <code>cli-v</code>, download the archive or package for your CPU, then verify it against <code>SHA256SUMS.txt</code>.
            </p>
          </div>
          <div className="download-note">
            <h3>What it installs</h3>
            <p>
              The full CLI installs the <code>ensemble</code> command, a bundled Node runtime, the local runner sidecar, and a user-level runner service when you run <code>ensemble runner install</code>. It does not need sudo for script installs.
            </p>
          </div>
        </section>

        <section className="section download-section">
          <div className="section-head">
            <p className="eyebrow">Run tasks</p>
            <h2>
              Sign in and let Ensemble use <em>one folder.</em>
            </h2>
            <p className="section-lede">
              Start with login. Then share a repo folder, add the model key this computer should use, and install or start the runner.
            </p>
          </div>
          <div className="download-two">
            <CopyCode label="After install" code={afterInstallCommands.join("\n")} />
            <CopyCode label="Start without login service" code="ensemble runner start" />
          </div>
          <div className="download-note">
            <p>
              Useful checks: <code>ensemble status</code>, <code>ensemble doctor</code>, and <code>ensemble update</code>.
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
                needed for code tasks. The download is about 120 MB because it carries its own Node runtime and local database.
              </p>
            </article>
            <article>
              <h3>Where do keys live?</h3>
              <p>
                Model keys you save with <code>ensemble keys set</code> stay encrypted on your computer and are never sent to Ensemble. MCP is read-only: the{" "}
                <code>ens_</code> key the CLI or the Connect page creates can read your Ensemble context and cannot change anything.
              </p>
            </article>
            <article>
              <h3>Where can tasks run?</h3>
              <p>
                Only in folders you share with <code>ensemble folders add</code>, and only while the runner is running. Remove a folder with{" "}
                <code>ensemble folders remove</code>. <code>ensemble logout</code> removes this computer from your account.
              </p>
            </article>
            <article>
              <h3>Will macOS or Windows warn about unsigned builds?</h3>
              <p>
                Not for Homebrew, Scoop, the install scripts, or the Linux packages: they do not mark the files as downloaded from the internet. A zip you download
                by hand in a browser may need “Open anyway” (macOS) or “Run anyway” (Windows) once.
              </p>
            </article>
            <article>
              <h3>What about the desktop app?</h3>
              <p>The desktop app is coming later. Use the CLI for runner and MCP setup today.</p>
            </article>
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
          <a href={site.repoUrl} rel="noopener">
            GitHub
          </a>
        </span>
      </footer>
    </>
  );
}
