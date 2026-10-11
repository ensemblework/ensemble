import type { IconName } from "@/components/icon";
import type { Faq } from "@/lib/schema";

// One page per search people make. Each says only what the product does today
// (docs/18_WHAT_IS_REAL.md); change the copy when the feature changes.
export type Topic = {
  slug: string;
  /** The <title>. Under about 60 characters. */
  title: string;
  /** The meta description. Under about 160 characters. */
  description: string;
  /** Short name for links, the breadcrumb and the footer. */
  label: string;
  eyebrow: string;
  heading: string;
  headingEm: string;
  lede: string;
  /** One line for the cards on the home page and under "Keep reading". */
  summary: string;
  icon: IconName;
  points: { icon: IconName; title: string; body: string }[];
  faq: Faq[];
};

export const TOPICS: Topic[] = [
  {
    slug: "ai-notes-app",
    title: "AI Notes App That Works With Your AI Agents | Ensemble",
    description:
      "Ensemble is an AI notes app: notes, meeting notes and task pages your assistant, Claude Code, Cursor and other AI agents can read as context. Free to start.",
    label: "AI notes app",
    eyebrow: "AI notes app",
    heading: "Notes your AI agents",
    headingEm: "can actually read.",
    lede: "Ensemble is an AI notes app for people who work with AI agents and LLMs. Write notes, meeting notes and task pages in one place. Your assistant and coding agents such as Claude Code, Cursor and Copilot read them as context, so you stop pasting the same background into every chat.",
    summary: "Notes, meeting notes and pages that your assistant and coding agents read as context.",
    icon: "quill",
    points: [
      {
        icon: "quill",
        title: "Notes, meeting notes and pages in one place",
        body: "A block editor with headings, lists, to-dos, tables, code, quotes and @mentions. Write standalone notes, keep a page on every task, and take meeting notes you can turn into a recap. Search finds a note by anything in its body, and deleted notes wait in Trash with Undo.",
      },
      {
        icon: "plug",
        title: "Notes that AI agents can read",
        body: "The assistant can search your notes. Editors and coding agents read the same notes, tasks and people through Ensemble's read-only MCP bridge: one command sets it up for VS Code, Cursor, Claude Code, Codex, Gemini CLI, Windsurf, Zed and more.",
      },
      {
        icon: "chain",
        title: "Bring your notes with you, take them anywhere",
        body: "Import from Notion (API or the Markdown and CSV export), Todoist, Linear, Jira, Trello, Asana, ClickUp, monday.com, GitHub Issues or any spreadsheet. Running an import again updates instead of duplicating. Download any page as PDF, Word, Markdown, HTML or text, or a whole space as a ZIP.",
      },
      {
        icon: "board",
        title: "Share notes with people, not just models",
        body: "Share a space or a single page with people you work with and see who is reading along. Send anyone a view-only or editable link, no account needed. Separate spaces keep work, study and side projects apart.",
      },
      {
        icon: "chip",
        title: "Any model, or none at all",
        body: "Writing, organising, searching and sharing notes needs no AI model. When you want the assistant, bring your own key for Gemini, OpenAI, Claude, OpenRouter, Ollama or GitHub Copilot. Keys are encrypted and checked with the provider before they are saved.",
      },
      {
        icon: "sunrise",
        title: "Notes that feed your day",
        body: "Meeting notes from Fireflies, Fathom, Granola, Otter and other tools land next to your own, matched to the calendar event. Your action items become proposed todos for today; what others owe you is listed as waiting on.",
      },
    ],
    faq: [
      {
        q: "What is an AI notes app?",
        a: "An AI notes app is a notes app where an AI model can read, search and work with what you write. In Ensemble your notes are also context for AI agents: the assistant searches them, and coding agents such as Claude Code, Cursor or Copilot can read them through MCP, so you do not have to paste them into a chat.",
      },
      {
        q: "Can AI agents read my Ensemble notes?",
        a: "Yes, when you connect them. The Ensemble assistant reads your workspace. Editors and coding agents use a read-only key from the Connect page or the ensemble mcp command; that key can read your notes and context and cannot change anything.",
      },
      {
        q: "Can I import my notes from Notion?",
        a: "Yes. Connect Notion or upload its Markdown and CSV export. Databases become projects, rows become tasks or pages, and page bodies keep their headings, lists, to-dos, code, tables and callouts. Importing again updates what came over, and Undo this import removes it.",
      },
      {
        q: "Do I need an AI model to use Ensemble for notes?",
        a: "No. Notes, meeting notes, search, sharing and downloads work without a model key. Add a key for Gemini, OpenAI, Claude, OpenRouter, Ollama or GitHub Copilot when you want the assistant or an agent.",
      },
    ],
  },
  {
    slug: "plan-your-day-with-ai",
    title: "Plan Your Day With AI: Briefing, Todos and Agents | Ensemble",
    description:
      "Plan your day with AI in Ensemble: mail, chat and meetings become proposed todos on one Today page, next to your calendar. You decide what you do and what AI agents do.",
    label: "Plan your day with AI",
    eyebrow: "AI day planner",
    heading: "Plan your day with AI,",
    headingEm: "then hand some of it off.",
    lede: "Ensemble reads the mail, chat, meetings and calendar you connect, turns the asks into proposed todos, and lays your day out on one Today page. You decide what you do yourself, what an AI agent does, and what waits for later.",
    summary: "Mail, chat and meetings become proposed todos on one Today page, next to your calendar.",
    icon: "sunrise",
    points: [
      {
        icon: "sunrise",
        title: "A Today page built from your real day",
        body: "Your Google or Outlook calendar, meetings with a place for notes, reminders, deadlines and what is waiting on you, as tiles you arrange. Pick a starting layout made for students, teachers, lawyers, engineers, builders or managers, then make it yours.",
      },
      {
        icon: "hand",
        title: "Asks become proposed todos",
        body: "Sync reads Gmail, Outlook, Teams, Slack, GitHub, Linear and your meeting-notes tool. An AI model picks out the real asks, skips newsletters, and proposes todos with a due date when there is one and the exact sentence they came from. Each one has three answers: I'll do it, Agent does it, Later.",
      },
      {
        icon: "board",
        title: "Hand work to an AI agent",
        body: "A todo you give the agent moves across the board while it gathers context, drafts and waits for you. Anything that leaves your workspace, like a calendar invite or a document change, waits for your yes.",
      },
      {
        icon: "quill",
        title: "A morning brief and a weekly recap",
        body: "A morning brief arrives at the time you choose. The weekly recap gathers the week's work and meeting recaps, ready to copy or download. Quiet nudges bring back tasks that have gone stale, so nothing rots on the list.",
      },
      {
        icon: "chip",
        title: "Capture a thought in a second",
        body: "Press C anywhere in Ensemble and type a sentence like “remind Mira about the contract Friday”; it becomes a task with its date. A small companion app makes the shortcut global: Command-Control-Shift-U on macOS, Ctrl+Alt+Shift+U on Windows and Linux.",
      },
      {
        icon: "shield",
        title: "Your plan, your rules",
        body: "Nothing is assigned behind your back, and connectors only read. Pick the model that plans with you, or none: if no model is reachable, a careful rule-based triage still proposes the obvious todos.",
      },
    ],
    faq: [
      {
        q: "How do I plan my day with AI in Ensemble?",
        a: "Connect your mail, calendar and chat, then press Sync. Ensemble proposes todos from the asks it finds, each with its source. Triage them (I'll do it, Agent does it, Later) and your Today page shows the day: calendar, todos, reminders and what is waiting on you.",
      },
      {
        q: "Does the AI change my calendar or send email on its own?",
        a: "No. Connectors read. When you ask the assistant to create a calendar event or a document, the change waits until you press Apply, and every applied change is recorded in the audit log.",
      },
      {
        q: "Which apps can Ensemble plan my day from?",
        a: "Gmail and Google Calendar, Outlook mail and calendar, Microsoft Teams chats, Slack, GitHub, Linear, and meeting-notes tools such as Fireflies, Fathom, Granola and Otter. You can also import tasks from Notion, Todoist, Asana, Trello, ClickUp, monday.com and Jira.",
      },
      {
        q: "Can I plan my day with my own LLM?",
        a: "Yes. Bring your own key for Gemini, OpenAI, Claude, OpenRouter, Ollama or GitHub Copilot, and choose which model does the planning. The provider bills you directly; Ensemble does not resell model usage.",
      },
    ],
  },
  {
    slug: "ai-context-management",
    title: "AI Context Management for LLMs and AI Agents | Ensemble",
    description:
      "AI context management with Ensemble: keep people, projects, notes, meetings and how you work in one place, and give that context to every LLM and AI agent over MCP.",
    label: "AI context management",
    eyebrow: "Context management",
    heading: "AI context management,",
    headingEm: "done once.",
    lede: "An AI agent or LLM is only as good as the context it gets. Ensemble keeps yours in one place: people, projects, notes, meetings, files and how you like work done. Then it hands that context to the assistant and to your editors, so you never type it in again.",
    summary: "People, projects and decisions kept once, then given to every LLM, agent and editor.",
    icon: "graph",
    points: [
      {
        icon: "graph",
        title: "Context that builds itself from your work",
        body: "People and repos are learned from the mail, chat, issues and meetings you connect. A person is recognised by any address or handle they use. Link a Slack channel, GitHub repo or Linear project to a project, and what arrives from it lands in the right place.",
      },
      {
        icon: "plug",
        title: "One context for every AI agent",
        body: "Ensemble's MCP bridge gives editors and agents the same briefs, notes, tasks, people and skills the assistant uses. Set it up with one command for VS Code, Cursor, Claude Code, Codex, Gemini CLI, Windsurf, Zed and others, or use the hosted MCP address with a read-only key.",
      },
      {
        icon: "quill",
        title: "Skills: how you like things done",
        body: "Versioned skills hold the way you write pull request descriptions, commit messages and replies. Edit them like any page; agents and the assistant use them when they draft, so the first draft already sounds like you.",
      },
      {
        icon: "board",
        title: "Spaces keep contexts apart",
        body: "Keep work, study and side projects in separate spaces, each with its own notes, tasks and context. Share a space with the people who need it, and keep your settings, keys and connected apps private.",
      },
      {
        icon: "shield",
        title: "You decide what leaves",
        body: "Connectors only read. Secret-looking strings are redacted before what they read is stored, tokens are encrypted, and disconnecting an app can delete what it read. MCP keys are read-only, and a model sees only what you send to the provider you chose.",
      },
      {
        icon: "chain",
        title: "Context you can audit",
        body: "Every agent action is written to a hash-chained, insert-only ledger with what it read and who approved it. Every prompt Ensemble uses can be read in Settings, and the code is public on GitHub.",
      },
    ],
    faq: [
      {
        q: "What is AI context management?",
        a: "AI context management means collecting, organising and supplying the background an AI model needs to do useful work: who people are, what a project is about, what was decided, and how you like things done. Ensemble keeps that context in one workspace and gives it to the assistant and to AI agents, so you do not paste it into every prompt.",
      },
      {
        q: "How do I give Claude Code, Cursor or Copilot my context?",
        a: "Install the Ensemble CLI and run ensemble mcp setup for your editor, or add the hosted MCP address with a read-only key from the Connect page. The editor can then read your briefs, notes, tasks, people and skills from Ensemble.",
      },
      {
        q: "What is MCP?",
        a: "MCP, the Model Context Protocol, is an open standard that lets AI apps and agents read tools and context from other software. Ensemble's MCP server is read-only: an agent can read your context through it and cannot change anything.",
      },
      {
        q: "Is my context sent to AI providers?",
        a: "Only when you use a model feature, and only to the provider you picked with your own key. Ensemble does not sell your data or use it for advertising. The privacy policy at ensemblework.com/privacy has the details.",
      },
    ],
  },
  {
    slug: "work-with-ai-agents",
    title: "Work With AI Agents: Shared Board and Approvals | Ensemble",
    description:
      "Collaborate with AI agents in Ensemble: one board for you and your agents, approvals before anything leaves, and one place where Claude Code, Codex, Cursor and Copilot ask.",
    label: "Work with AI agents",
    eyebrow: "Human and AI agent collaboration",
    heading: "Work with AI agents",
    headingEm: "like teammates.",
    lede: "Ensemble is a workspace for collaborating with AI agents and LLMs. You and your agents share one board, one set of notes and one context. Agents pick up the work you assign, ask when they need you, and wait for your approval before anything leaves.",
    summary: "One board, approvals, and a single place where every AI agent asks for you.",
    icon: "board",
    points: [
      {
        icon: "board",
        title: "One board for you and your agents",
        body: "Lanes for You, Agent and Needs you. See what the agent is doing, how far it is and what it plans next. Give a task to the agent, keep it yourself, or give it to a person in a shared space.",
      },
      {
        icon: "hand",
        title: "Every agent asks in one place",
        body: "Claude Code, Codex, GitHub Copilot and Cursor send their permission prompts and questions to Needs me, with their own options and room for your own answer. Answer once, for the session, or always, from the web, your phone or the terminal. The hook never allows on its own.",
      },
      {
        icon: "laptop",
        title: "Agents run on your computer, sandboxed",
        body: "The ensemble CLI runs assigned tasks in a folder you choose, inside the computer's own sandbox: Seatbelt on macOS, bubblewrap or Landlock on Linux, a separate sandbox account on Windows. No Docker. Hand the task to Ensemble's agent or to Claude Code with your own sign-in.",
      },
      {
        icon: "shield",
        title: "Approvals first",
        body: "Anything that leaves your workspace waits for a yes from you. Pause the agent, reject a draft, or undo its writes. In a folder you trust, let it run unattended and read every decision it made at the end.",
      },
      {
        icon: "chain",
        title: "A record of everything an agent did",
        body: "Every agent action lands in a tamper-evident, hash-chained ledger with its inputs and approvals, so a run can be replayed and checked later.",
      },
      {
        icon: "chip",
        title: "Any model, your key",
        body: "Run agents on Gemini, OpenAI, Claude, OpenRouter, Ollama or GitHub Copilot with your own key. Keys are encrypted and never leave the model runtime.",
      },
    ],
    faq: [
      {
        q: "What does it mean to work with AI agents?",
        a: "Working with AI agents means handing real tasks to software that can plan and act, not just answer a chat. In Ensemble you assign a task on a shared board, the agent works with the same notes and context you have, and it comes back to you for decisions and approvals.",
      },
      {
        q: "Which AI agents work with Ensemble?",
        a: "Ensemble has its own agent that runs on Gemini, OpenAI, Claude, OpenRouter, Ollama or GitHub Copilot with your key, and it can hand coding tasks to Claude Code with your own Claude sign-in. Permission prompts from Claude Code, Codex, GitHub Copilot and Cursor come to Needs me, and editors read your context over MCP.",
      },
      {
        q: "Can an AI agent act without my approval?",
        a: "Not for anything that leaves your workspace: that waits for your approval. Commands run in a sandbox inside a folder you chose, and only a folder you trust can run unattended; paths outside it are refused.",
      },
      {
        q: "Can people and AI agents collaborate in the same workspace?",
        a: "Yes. Share a space or a single page, task, board or diagram with people. Everyone sees the agent's runs and who is on each page, and a member's agent tasks run on their own computer.",
      },
    ],
  },
];

export function topicBySlug(slug: string): Topic {
  const topic = TOPICS.find((t) => t.slug === slug);
  if (!topic) throw new Error(`No landing topic named ${slug}`);
  return topic;
}
