/**
 * Desktop notifications, gated by Settings → Desktop reminders and quiet hours.
 * The Notifier component keeps `config` current; anything can call notify().
 */
type Config = { enabled: boolean; quiet: { enabled: boolean; from: string; until: string } };

let config: Config = { enabled: false, quiet: { enabled: true, from: "19:00", until: "08:00" } };

export function setNotifyConfig(next: Config): void {
  config = next;
}

const minutes = (value: string): number => {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export function inQuietHours(now = new Date()): boolean {
  if (!config.quiet.enabled) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  const from = minutes(config.quiet.from);
  const until = minutes(config.quiet.until);
  return from <= until ? current >= from && current < until : current >= from || current < until;
}

export function notify(title: string, body: string, options: { urgent?: boolean; tag?: string; href?: string } = {}): boolean {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  if (!config.enabled) return false;
  if (!options.urgent && inQuietHours()) return false;
  const note = new Notification(title, {
    body,
    tag: options.tag,
    icon: "/icon-192.png",
    badge: "/icon-maskable-192.png",
  });
  if (options.href) {
    note.onclick = () => {
      window.focus();
      window.location.href = options.href!;
    };
  }
  return true;
}

const SOURCE: Record<string, string> = { cursor: "Cursor", claude: "Claude Code", copilot: "VS Code Copilot", codex: "Codex" };

/** An agent in another app is blocked on you. Urgent: it ignores quiet hours, because the tool call is waiting. */
export function notifyDecision(title: string, source: string): void {
  notify(`${SOURCE[source] ?? "An agent"} needs you`, title, { urgent: true, tag: `decision:${title}`, href: "/needs-me" });
}
