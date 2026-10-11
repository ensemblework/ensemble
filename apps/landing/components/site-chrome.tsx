import { Wordmark } from "@/components/mark";
import { site } from "@/lib/site";
import { TOPICS } from "@/lib/topics";

const SHORT: Record<string, string> = {
  "ai-notes-app": "Notes",
  "plan-your-day-with-ai": "Plan your day",
  "ai-context-management": "Context",
  "work-with-ai-agents": "Agents",
};

export function GitHubLink({ className = "" }: { className?: string }) {
  if (!site.repoPublic) return null;
  return (
    <a className={className} href={site.repoUrl} rel="noopener">
      GitHub
    </a>
  );
}

export function SiteHeader() {
  return (
    <header className="nav">
      <a href="/" className="nav-brand" aria-label="Ensemble home">
        <Wordmark />
      </a>
      <nav className="nav-links" aria-label="Pages">
        {TOPICS.map((t) => (
          <a key={t.slug} href={`/${t.slug}`}>
            {SHORT[t.slug] ?? t.label}
          </a>
        ))}
        <a href="/download">Download</a>
        <GitHubLink />
      </nav>
      <a className="btn btn-small" href={site.appUrl}>
        Open the app
      </a>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="footer">
      <div className="footer-brand">
        <Wordmark />
        <span className="faint">You and your agents, stronger together.</span>
      </div>
      <nav className="footer-links" aria-label="More">
        <a href={site.appUrl}>App</a>
        <a href="/download">Download</a>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <GitHubLink />
      </nav>
      <nav className="footer-links footer-topics" aria-label="What Ensemble does">
        {TOPICS.map((t) => (
          <a key={t.slug} href={`/${t.slug}`}>
            {t.label}
          </a>
        ))}
      </nav>
    </footer>
  );
}
