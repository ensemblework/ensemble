/**
 * "Ask Ensemble" on the Connect pages: one click opens the assistant with a setup question already
 * sent, at the person's Medium tier, in a new chat. The question is what the person sees; the facts
 * below go with it as the turn's reference context (never shown), so the answer can name the exact
 * command, file and check for their app, extension and way of connecting. No key is ever included.
 */
import type { AppCard } from "./catalog";
import { EDITORS, HOSTED_KEY_PLACEHOLDER, METHOD_LABELS, type ConnectMethod, type ConnectOs } from "./configs";
import { EXTENSIONS, HOSTS, type Extension, type HostId } from "./extensions";

export type HelpPlace = {
  app?: AppCard | null;
  method?: Exclude<ConnectMethod, "source">;
  os?: ConnectOs;
  extension?: Extension | null;
  /** The person's bridge keys: how many, and how many may make changes. */
  keys?: { count: number; canWrite: number };
  /** The desktop app kept only on this computer. */
  localOnly?: boolean;
  hostedUrl: string;
};

export type HelpQuestion = { id: string; label: string; prompt: string };

const OS_NAME: Record<ConnectOs, string> = { mac: "macOS", windows: "Windows", linux: "Linux" };

/** The questions worth one click from where the person is. Specific first, general after. */
export function helpQuestions(place: HelpPlace): HelpQuestion[] {
  const out: HelpQuestion[] = [];
  const app = place.app;
  const ext = place.extension;
  if (ext && app) {
    out.push({ id: "ext-setup", label: `Set up Ensemble in ${ext.name} inside ${app.name}`, prompt: `Walk me through connecting Ensemble to the ${ext.name} extension in ${app.name}, step by step.` });
    out.push({ id: "ext-missing", label: `${ext.name} does not show Ensemble`, prompt: `I set up Ensemble, but the ${ext.name} extension in ${app.name} does not show it. What should I check?` });
  } else if (app) {
    out.push({ id: "app-setup", label: `Walk me through connecting ${app.name}`, prompt: `Walk me through connecting Ensemble to ${app.name}, step by step.` });
    out.push({ id: "app-missing", label: `${app.name} does not show Ensemble`, prompt: `I set up Ensemble, but ${app.name} does not show it or its tools. What should I check?` });
  }
  if (app && app.id in HOSTS && !ext) {
    out.push({ id: "extension", label: `Use it from an AI extension in ${app.name}`, prompt: `I use an AI extension inside ${app.name} (like Claude Code or Codex). How do I connect Ensemble to that extension?` });
  }
  out.push({ id: "which-way", label: "CLI, desktop app or hosted URL: which should I use?", prompt: "Which way should I connect Ensemble to my editor: the CLI, the desktop app or the hosted URL? Help me choose." });
  out.push({ id: "not-listed", label: "My app or extension is not listed", prompt: "The app or extension I use is not listed on the Connect page. Ask me which one, and in which editor, then tell me how to connect Ensemble to it." });
  out.push({ id: "changes", label: "Let it make changes, or keep it read only", prompt: "Can my editor make changes in Ensemble through MCP, or only read? How do I choose?" });
  return out;
}

function extensionFacts(item: Extension, hostedUrl: string): string {
  const facts = { token: null, publicApiUrl: hostedUrl.replace(/\/mcp$/, ""), repoRoot: "", bridgeScript: "", node: "", hubApiUrl: "", httpUrl: "" };
  const cli = item.cli("mac");
  const hosted = item.hosted(facts, null);
  const line = (setup: ReturnType<Extension["cli"]>) => [setup.steps.join(" "), setup.snippet ? `${setup.snippet.label}:\n${setup.snippet.text}` : ""].filter(Boolean).join("\n");
  return [
    `### ${item.name} (${item.maker}; in ${item.hosts.map((host) => HOSTS[host as HostId]).join(", ")})`,
    `Reads its MCP servers from: ${item.reads}`,
    `With the CLI: ${line(cli)}`,
    `With the hosted URL: ${line(hosted)}`,
    `Check: ${item.check}`,
    item.caution ? `Watch out: ${item.caution}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** What the assistant is told along with the question. Plain facts and how to answer; never a key. */
export function helpContext(place: HelpPlace): string {
  const setupIds = Object.values(EDITORS).map((editor) => `${editor.name}: ${editor.setupId}${editor.printOnly ? " (prints the config to paste)" : ""}`).join("; ");
  const where = [
    place.app ? `The ${place.app.name} guide` : "The Connect page (all apps)",
    place.extension ? `with the ${place.extension.name} extension picked` : "",
    place.method ? `showing ${METHOD_LABELS[place.method].title}` : "",
    place.os ? `for ${OS_NAME[place.os]}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const keys = place.keys
    ? place.keys.count
      ? `They have ${place.keys.count} key${place.keys.count === 1 ? "" : "s"} for editors; ${place.keys.canWrite} may make changes.`
      : "They have not made a key for editors yet."
    : "";
  return [
    "The person asked this from Ensemble's Connect page, where editors and AI apps are connected to Ensemble through MCP. Answer as a setup guide:",
    "- Short numbered steps with the exact command, file path and config for their app, using the facts below. Do not invent paths or settings; when you do not know where an app keeps its MCP servers, say how to find out (its MCP settings or docs) and give the server's shape.",
    `- Never ask for their ens_ key in this chat and never write a real key; write ${HOSTED_KEY_PLACEHOLDER} where it goes. Keys belong in user-level config, not in a file inside a repository that gets committed.`,
    "- End with how to check it worked in that app. Under 220 words unless they ask for more. Ask one question first only when you cannot tell which app or editor they mean.",
    "",
    `Where they are: ${where}.${keys ? ` ${keys}` : ""}${place.localOnly ? " This is the Ensemble desktop app kept only on this computer." : ""}`,
    "",
    "Ways to connect:",
    `1. Ensemble CLI (recommended): install it, run \`ensemble login\`, then \`ensemble mcp setup <id>\`, which writes the editor's config; the editor then starts \`ensemble mcp\` (stdio). Add \`--print\` to print instead of write, \`--hosted\` to write the hosted URL form. Setup ids: ${setupIds}. \`ensemble status\` and \`ensemble doctor\` check the install. An app started from the Dock may not find \`ensemble\` on PATH: use the full path from \`which ensemble\` (or \`where ensemble\` on Windows).`,
    "2. Ensemble desktop app: when it keeps Ensemble only on this computer, its own Connect page shows a stdio command for its runtime (no CLI and no key; the app must stay open). With an Ensemble account, use the CLI or the hosted URL instead.",
    `3. Hosted URL (nothing to install): ${place.hostedUrl}, Streamable HTTP, one header \`Authorization: Bearer ${HOSTED_KEY_PLACEHOLDER}\` with an ens_ key from Connect your apps.`,
    "What a key can do: it always reads Ensemble (briefs, tasks, pages, people, files, diagrams, plots, meetings). If Let editors and agents make changes was ticked when it was made (on by default), it can also make changes (tasks, pages, boards, diagrams, plots, files, projects, people), each undoable in Ensemble. The CLI's key follows the choice made at `ensemble login`. A key without changes can be replaced by making a new one.",
    "Servers load when an app starts a session: after adding Ensemble, start a new session or reload the editor window.",
    "",
    "AI extensions inside an editor keep their own MCP server list; adding Ensemble to the editor's mcp.json does not reach them:",
    ...(place.extension ? [extensionFacts(place.extension, place.hostedUrl)] : []),
    ...EXTENSIONS.filter((item) => item.id !== place.extension?.id).map((item) => {
      const cli = item.cli("mac").snippet;
      return `- ${item.name} (${item.maker}): reads ${item.reads}${cli ? ` CLI way: ${cli.text.includes("\n") ? `add to ${cli.label}: ${cli.text.replace(/\s+/g, " ")}` : `\`${cli.text}\``}.` : ""} Check: ${item.check}${item.caution ? ` Watch out: ${item.caution}` : ""}`;
    }),
  ].join("\n");
}
