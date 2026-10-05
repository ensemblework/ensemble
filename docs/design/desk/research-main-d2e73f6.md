# Ensemble main @ d2e73f6: research map

*Read-only research, 30 Sep 2026, 19:25–19:40 IST.* Code was read from my own detached worktree `/workspace/ensemble/main-d2e73f6` at origin/main d2e73f6. All paths below are relative to that worktree unless noted. Feature-2 was read only through git objects (`git show 2bfcde5:…`, `git show fd14604:…`). I did not touch the live checkout `/workspace/ensemble/repo` (feature-2 @2bfcde5) or `/workspace/ensemble/rebase-wt` (f2-rebase).

**Deviation from the brief.** `/workspace/ensemble/main-wt` already existed as a clean but stale worktree at 8e8a89c that someone else owns. I left it alone and added `/workspace/ensemble/main-d2e73f6` instead. There I ran `pnpm install --filter @ensemble/hub-web...` and `next build` for the bundle numbers (logs: `/tmp/main-install.log`, `/tmp/main-build.log`). I did not start main's app: the live DB and API are feature-2, and `/api/diagrams` needs main's diagram migrations. Everything below comes from code and the build output.

---

## 0. What landed on main since the merge base 1741548 (15 commits, 153 files, +16,630 lines)

| Commit | What |
|---|---|
| c2cd0d5, 327045e, bdae3a2 → merge 643c5cb | Mac start script, `pnpm dev` without turbo, connector-check resilience (`scripts/*`, `connectors/accounts.ts`, `base.ts`) |
| 1fa0257 → merge 3edc90b | VS Code themes (`packages/ide-theme`, `routes/themes.ts`, `components/code/ide-theme.tsx`, `theme-picker.tsx`) |
| dcd79a8 | Block-diagram language and canvas |
| 84d505b | Palette, canvas-only view |
| 3c3caa6 | Group frames, fit |
| 64c8ad1 | CodeMirror IDE editor using the shared IDE themes |
| 929af08 | Agents draw diagrams, "show them where the work is" |
| bef49f4 | Agents read repos |
| e84f21f | Read a repo from its link, refine, history |
| 400e416 | Merge block diagrams |
| d2e73f6 | Migration `20260930140000_diagram_links_and_revisions` |

---

## 1. Block diagrams: structure

### 1.1 Docs and skill
- DSL reference: `docs/21_BLOCK_DIAGRAMS_DSL.md`. Cheatsheet: `docs/21_BLOCK_DIAGRAMS_CHEATSHEET.md`. Agent guide: `docs/22_BLOCK_DIAGRAMS_FOR_AGENTS.md`.
- Skill file `.github/skills/block-diagrams/SKILL.md` is loaded by `apps/hub-api/src/assistant/diagram-skill.ts`. It's injected only when the message mentions diagram, flowchart or similar, or the open page is `/diagrams…`.

### 1.2 Pipeline
text → `parse()` → JSON model v1 → ELK layered layout → React Flow canvas, or SVG via `renderDiagramSvg`.

- Package: `packages/block-diagrams/src/`. DOM-free, no React. Deps are `elkjs` 0.12.0 (EPL-2.0) and `zod`.
  - `parse.ts` (930 lines): forgiving parser. Errors and warnings are reported per line and the remaining lines still apply.
  - `model.ts`: v1 model. Nodes, edges and groups are maps keyed by id (Y.Map-ready).
  - `shapes.ts`, `palette.ts`, `layout.ts`: ELK loaded via dynamic `import("elkjs/lib/elk.bundled.js")`.
  - `svg.ts`: `renderDiagramSvg`, XML-escaped, server-safe.
  - `print.ts`: model → canonical text, used for canvas edits → text.
  - `mermaid.ts`: import of flowchart/graph, plus `toMermaid`.
  - `explain.ts`, `refine.ts` (`applyDiagramEdits` ops), `edit.ts`, `highlight.ts`.
  - `templates.ts`: `DIAGRAM_TEMPLATES`.

### 1.3 Language and grammar (`docs/21_BLOCK_DIAGRAMS_DSL.md`, `parse.ts`)
- Line-oriented statements:
  - `title`
  - `direction` down/up/left/right, plus aliases
  - `curve` straight/curved/elbow
  - `node|block`
  - `edge|connect|link`
  - `group` with either `{}` or indentation
  - `text|textbox`
  - `layout`
  - comments `#` and `//`
- 15 shapes: rectangle, rounded, diamond, circle, ellipse, cylinder, server, triangle, parallelogram, document, cloud, actor, hexagon, note, trapezoid.
- 10 named colours plus hex. 8 ports: n ne e se s sw w nw.
- Arrows: `>` `->` `=>` `-->` `--` `..` `<>` `<-->` `<`. Chains (`a > b > c`) and fans are allowed. `locked`/`pinned` fix positions.
- "Kinds" are one engine drawing boxes and arrows. The agent guide lists flowchart, architecture, sequence-style, data pipeline, ER-ish, org, decision tree, and repo/module map (`docs/22_…`).
- The 11 starter templates in `DIAGRAM_TEMPLATES` (`templates.ts`) are flowchart, architecture, journey, decision, timeline, org, mindmap, network, er ("Data model"), sequence, and plan.

### 1.4 Web: routes, canvas, IDE editor, themes
- `apps/hub-web/app/(hub)/diagrams/page.tsx`: list, search, a "New diagram" template gallery, and an inline delete confirm.
- `apps/hub-web/app/(hub)/diagrams/[id]/page.tsx` → `components/diagrams/editor.tsx`:
  - Split editor with autosave every 800 ms, carrying a `version` (the server returns 409 on conflict).
  - Minimum window 1024×640.
  - Reorganize, Fit vertically, Fit horizontally, Lock.
  - Canvas-only view on Alt+Shift+F.
- Canvas:
  - `components/diagrams/canvas.tsx` and `nodes.tsx` use `@xyflow/react`.
  - ELK runs in a worker (`layout.worker.ts`, `layout-client.ts`).
  - The canvas theme follows `document.documentElement.dataset.theme` (the app theme), not the IDE theme. Diagram CSS is in `app/globals.css` from L913, with `--diagram-line/dot/paper`.
- IDE text editor:
  - `components/diagrams/diagram-code.tsx` (`@uiw/react-codemirror`) and `diagram-language.ts`.
  - Syntax highlighting, a lint gutter with quick fixes, autocomplete, and comment/format keys.
- Themes: `codeMirrorTheme(useIdeTheme())`. The whole editor sits inside `IdeSpace` from `components/code/ide-theme.tsx`, the same picker and theme as the Code tab.
- Export: `components/diagrams/export-image.ts` does PNG, JPG, SVG, and PDF (via `jspdf`).
- `components/diagrams/diagram-more.tsx` holds:
  - Ask AI to refine, Explain, Copy Mermaid, Copy image, Duplicate.
  - History/Restore.
  - A freshness banner ("Refresh with AI").

### 1.5 Nav hooks
- Sidebar WORKSPACE item "Block diagrams" (Workflow icon), after Code: `components/shell/sidebar.tsx`.
- Command palette page and a "Create diagram" action: `components/shell/command-palette.tsx`.
- `g d` shortcut: `components/shell/shortcuts-host.tsx`. Prefetch: `lib/prefetch.ts`. Topbar title: `components/shell/topbar.tsx`.
- Assistant-dock copy for `/diagrams`: `components/assistant/assistant-dock.tsx` L65.

### 1.6 "Show them where the work is" (Context and graph tie-in)
- `components/diagrams/make-diagram.tsx` (`MakeDiagramButton`) prefills an assistant prompt. It appears on:
  - the task page: `components/task/task-page.tsx`
  - the project page and each deliverable, plus a "Diagrams" list: `app/(hub)/projects/[id]/page.tsx`
  - the Context → Repos tab: `components/context/repos-prefs.tsx`
- `components/diagrams/diagram-card.tsx` is a read-only SVG card with pan, zoom and compact modes.
- Page editor: an `@diagram` mention, a "New diagram" slash item, and an inline card node view (`components/editor/extensions.ts`, `block-editor.tsx`, `suggestion-menu.tsx`).
- Shared types: mention kind `diagram` in `packages/shared-types/src/assistant.ts`, `domain.ts`, and `mentions.ts` (→ `/diagrams/:id`).
- Context: diagrams are in `/api/entities` (`apps/hub-api/src/routes/context.ts`) but **not among the `/api/context/graph` nodes**, and `DiagramLink` edges aren't drawn.

### 1.7 Data model and migrations (`apps/hub-api/prisma/schema.prisma`)
- `BlockDiagram`: id, userId, title, source (text), document (JSON), version, createdAt, updatedAt. **No `deletedAt`.**
- `BlockDiagramRevision`: unique on (diagramId, version). Capped at 30 per diagram by `apps/hub-api/src/diagrams/history.ts`.
- `DiagramLink`: diagramId, targetKind ∈ page|task|deliverable|project|repo, targetId.
- User relations: `diagrams`, `diagramLinks`.
- Migrations: `prisma/migrations/20260930120000_block_diagrams` and `20260930140000_diagram_links_and_revisions`. Both are idempotent (IF NOT EXISTS and DO blocks).

### 1.8 API (`apps/hub-api/src/routes/diagrams.ts`, registered in `src/index.ts` with `themeRoutes`)
| Method | Path | Notes |
|---|---|---|
| GET / PUT | `/api/diagrams/links` | PUT replaces the link set for a target. **Doesn't check that the target belongs to the user.** The assistant path does, via `assertLinkTarget` |
| GET / POST | `/api/diagrams` | POST normalizes Mermaid input to Ensemble text |
| GET / PATCH | `/api/diagrams/:id` | PATCH does an optimistic version check (409) and writes a revision |
| GET | `/api/diagrams/:id/revisions` | |
| POST | `/api/diagrams/:id/restore`, `/:id/duplicate` | |
| GET | `/api/diagrams/:id/freshness` | Compares linked task/project/deliverable/repo `updatedAt`. **One query per link (N+1)** |
| GET | `/api/diagrams/:id/explain` | Explanation plus Mermaid |
| DELETE | `/api/diagrams/:id` | **Hard delete.** Revisions cascade. No Trash, no UndoEntry |

### 1.9 Agents
Hub assistant tools are in `apps/hub-api/src/assistant/tools/diagrams.ts`, registered in `assistant/registry.ts`. All are write area **"context"**.
- Reads: `hub_list_diagrams`, `hub_get_diagram`, `hub_validate_diagram`, `hub_explain_diagram`.
- Writes (preview → Apply):
  - `hub_create_diagram`, which can create links
  - `hub_update_diagram`, for full text or find/replace
  - `hub_edit_diagram`, with ops add_node, remove_node, rename_node, add_edge, remove_edge, move_to_group, set_node, set_curve, patch
- The writes are flagged `undoable: true`, but `UndoModel` in `src/lib/undo.ts` has no diagram, so nothing is journaled. Revisions are the only undo.
- `tools/diagram-context.ts` → `hub_diagram_context` returns bounded text for a task, project, deliverable, meeting or repo.
- `tools/repos.ts` → `hub_repo_overview` and `hub_repo_read_file`, also area "context".
- Prompt wiring: a system-prompt line in `assistant/state.ts`; `assistant/agent.ts` appends `diagramGuidance`.

Repo reading lives in `apps/hub-api/src/repo/locate.ts`, `mirror.ts` and `read.ts`. It tries three sources in order:
1. A local checkout under the allowed roots: `ENSEMBLE_WORKSPACE_ROOT`, `settings.terminal.roots`, and job and review repo paths.
2. A shallow partial-clone mirror at `<workspaceRoot>/.cache/repo-mirrors/<user>/<repo>`. TTL 6 h, 25 s timeout, 200 MB cap. `cacheDir` is in `workspace/guard.ts` L329. Since it's a dot dir, `discoverRepos` in `lib/git.ts` never lists mirrors as repos.
3. The GitHub API.

Limits: the tree is capped at 200 entries and depth 4, and reads at 32 KB. `isSecretPath` (`read.ts` L51) blocks `.env*`, `.npmrc`, `.ssh`, keys, `*.pem` and `credentials`. `.gitignore`d and skipped directories are refused, and paths are jailed.

Context-bridge MCP (`apps/context-bridge/src/server.ts`) adds `ensemble_repo_overview`, `ensemble_repo_file`, `ensemble_diagrams`, and `ensemble_read` with kind `diagram`. The hub side is `src/bridge/routes.ts` (`/api/bridge/diagrams`, `/api/bridge/repos/:id/overview|file`) and `bridge/service.ts`. `bridge/gaps.ts` lists diagram writes as intentionally not bridged, so the bridge stays read-only.

**`apps/agent-runtime` has no diagram changes.**

### 1.10 Undo, sharing, export, permissions
- Ownership: every query is filtered by `userId` (`routes/diagrams.ts`). There's no sharing, collaborators or public link. Export and copy are the only ways out.
- Bridge tokens (scope "bridge") are read-only: `bridge/auth.ts` `readOnlyTokenRejected`.
- Assistant writes are gated only by `settings.assistant.allowedWriteAreas` containing "context" (`toolsFor` in `registry.ts`), plus writePolicy preview/Apply. There's no dedicated "diagrams" area.
- Undo:
  - The text pane has CodeMirror history.
  - The canvas has no undo of its own.
  - **Bug risk:** the global Ctrl/Cmd+Z handler in `components/shell/topbar.tsx` L97–111 skips only inputs and `.cm-editor`. On the diagram canvas it fires the app's task-content undo instead.
- Revisions: every autosave PATCH writes a revision and the cap is 30, so autosaving every 800 ms can push useful history out within minutes of editing (`diagrams/history.ts`).

### 1.11 Dependencies and bundle cost (main `next build`, `/tmp/main-build.log`)
New hub-web deps (`apps/hub-web/package.json`):
- `@xyflow/react` ^12.12, `jspdf` ^4.2.1
- `@codemirror/{autocomplete,commands,language,lint,state,view}`, `@lezer/highlight`
- `@ensemble/block-diagrams`, `@ensemble/ide-theme`

`next.config.ts` adds `transpilePackages` and an ELK `noParse`.

| Route | Page | First load |
|---|---|---|
| `/diagrams/[id]` | 338 kB | **512 kB**. jspdf chunk 4d9f3bfc is 330 kB (104 kB gz) and loads eagerly. xyflow chunk ba4fb354 |
| `/diagrams` | 7.3 kB | 164 kB |
| `/projects/[id]` | | 170 kB, which includes block-diagrams core chunk 8662 (66 kB, 21.6 kB gz) for `DiagramCard` |
| ELK (async chunk f541192b) | | 1.45 MB (431 kB gz), lazy and worker-loaded |
| For reference | | Today 149, Context 112, Board 153, /code/review 176, Settings 170, tasks/[id] 166. Shared 104 kB; middleware 34.4 kB |

---

## 2. Every nav item, page and surface on main

Sidebar (`apps/hub-web/components/shell/sidebar.tsx`):

| Group | Item → route | Purpose |
|---|---|---|
| PRIMARY | Today → `/today` | Day focus, proposals to accept, calendar, meeting cues, stale nudges (`components/today/*`). No widget grid on main |
| | Board → `/board` | Move work between statuses (kanban) |
| | Needs me → `/needs-me` | Approvals and questions waiting on you (badge) |
| WORKSPACE | Runs → `/runs` | What the agent did: traces, tool calls, cost |
| | Context → `/context` | Tabs: People, Projects, Repos, Preferences, Sources, Artifacts & sync, Graph |
| | Skills → `/skills` | Skill library the agent can use |
| | Workspace → `/workspace` | Agent job queue lanes |
| | Code → `/code` (+ `/code/review`) | Review agent changes, file editor, terminal, commit. Uses IDE themes |
| | **Block diagrams → `/diagrams`** (+ `/diagrams/[id]`) | Diagram list/gallery and editor (new on main) |
| | Metrics → `/metrics` | Calls, cost, trust, governance |
| | Meeting notes → `/meetings` | Notes and actions from meetings |
| | Weekly recap → `/recap` | Done, decided, slipped |
| | Completed → `/completed` | Finished tasks |
| | Trash → `/trash` | Restore deleted items (diagrams never land here) |
| Bottom | Connect → `/connect`, `/connect/[app]` | Let an outside app or editor read Ensemble via the bridge |
| | Settings → `/settings` | Assistant, appearance, IDE theme, connections, reminders, terminal, setup |
| | Connections card and account menu | Connector health, sign out |

Other routes:
- `/projects` redirects to `/context?tab=projects`. `/projects/[id]` is the project page.
- `/tasks/[id]` is the task page.
- `/welcome` has three optional cards: model key, connect accounts, editors.
- `/login`; `/signup` redirects to `/welcome`; `/` redirects to `/today`.

Global surfaces (`components/shell/*`): command palette (⌘K), ask bar, quick capture, peek panel, notification bell, activity panel, assistant dock, the `@ensemble` panel (`components/ensemble/panel.tsx`), comments layer, shortcuts help (`?`), and the `g x` go-shortcuts.

---

## 3. Templates, personas and flags: main vs feature-2

### 3.1 Main
- **No** `/start`, signup templates, widgets (`widgets.ts`), `WidgetLayout`/`TemplateApplication` models, onboarding fields, marketplace, or module gating.
- Personas exist only as `ActAs` = general | student | engineer | teacher | lawyer (`packages/shared-types/src/assistant.ts` L64). `packages/shared-types/src/personas.ts` has `personaBlock` (tone) and `quickActions`. They're used by:
  - the `@ensemble` panel ACTS selector (`components/ensemble/panel.tsx`, API `apps/hub-api/src/routes/ensemble.ts`)
  - Settings setup (`components/settings/setup.tsx`)
- Presets: accent presets indigo, tide, ember, rose and brass (`apps/hub-web/lib/accent.ts`), and 11 built-in IDE themes plus Ensemble Default (`packages/ide-theme`).

### 3.2 Flags and toggles on main
- Env for hub-api (`apps/hub-api/src/config.ts` and others):
  - `ENSEMBLE_DEV_AUTH_BYPASS`, `ENSEMBLE_DEV_USER_ID`
  - `ENSEMBLE_AUTONOMY_LEVEL`, `ENSEMBLE_WORKSPACE_ROOT`
  - `ENSEMBLE_INTERNAL_TOKEN`, `ENSEMBLE_BRIDGE_ALLOW_DEFAULT_INTERNAL_TOKEN`
  - `ENSEMBLE_SCHEDULER=off` (`jobs/scheduler.ts`)
  - `ENSEMBLE_MODEL_CODER`, `ENSEMBLE_MODEL_PLANNER`
  - `NEXT_PUBLIC_HUB_API` (web)
- Env for agent-runtime: `ENSEMBLE_LLM_PROVIDER`, `ENSEMBLE_ALLOW_EXTERNAL_RECIPIENTS`, `ENSEMBLE_DAILY_HIGH_RISK_LIMIT`, `ENSEMBLE_TENANT_DOMAINS`.
- Per-user Settings (`packages/shared-types/src/assistant.ts` Settings):
  - `assistant.allowedWriteAreas` (tasks, projects, context, skills, reminders, runs), writePolicy, actAs, autonomy
  - `terminal.enabled`, `terminal.roots`
  - `connections[id].enabled`
  - `fetch.scheduled` / `proposeTodos`
  - quietHours, morningBrief, staleNudge, desktopReminders
  - `appearance` (theme dark/light/system, font, reduceMotion, accent preset or custom hex)
  - `ideTheme` (activeId plus up to 3 favourites; also in localStorage `ensemble.ideTheme`)
- Tokens: ApiToken scope "bridge" is read-only.
- No plan, billing or feature-flag service.

### 3.3 Feature-2 (design doc `docs/design/marketplace-and-templates.md` @2bfcde5, `packages/shared-types/src/modules.ts`)
- `OPTIONAL_MODULES` = code, workspace, runs, metrics, skills. `moduleForPath()` returns null for core or unknown paths.
- A per-session `modules` column that fails closed. Middleware and API refuse removed modules.
- 25 signup templates at `/start`, and widget layouts (`widgets.ts`).
- Hidden marketplace `mkt.*` templates with labels, lens, accent (5 presets), actAs and starters.
- New ActAs values: researcher, manager, aspirant, maker.
- Migrations: `20260929000000_pre_feature_schema`, `20260929190000_widget_layouts`, `20260930100000_module_set`, `20260930120000_marketplace_apply`.

### 3.4 Collisions
- **Files touched by both branches since 1741548** (`git diff --name-only`, intersected):
  - Root: README.md, package.json, scripts/agent-dev.sh, scripts/doctor.sh, docs/01_TECH_STACK_AND_ENVIRONMENT.md
  - Hub-api:
    - package.json, `prisma/schema.prisma`, `src/index.ts`
    - `assistant/{agent,registry,state}.ts`
    - `bridge/{gaps,routes,service}.ts`
    - `connectors/{accounts,base}.ts`
    - `routes/context.ts`, `routes/views.ts`
  - Hub-web: `app/(hub)/settings/page.tsx`, `app/(hub)/today/page.tsx` (one line), `app/globals.css`, `components/shell/{command-palette,sidebar,topbar}.tsx`, `lib/api.ts`
  - Shared-types: package.json, `src/assistant.ts`, `src/domain.ts`
- **Migration timestamp clash:** `20260930120000_block_diagrams` (main) and `20260930120000_marketplace_apply` (feature-2). Prisma orders them lexically and both are idempotent, so it works. **Don't rename either one**: the live DB already has `marketplace_apply` recorded in `_prisma_migrations`, so a rename would look like a new migration. Just document it.
- **Gating:**
  - At f2-rebase 096edd0 (19:22 IST), diagrams, `/api/themes` and the bridge repo reads were **ungated**.
  - **Update:** f2-rebase **fd14604** (19:31 IST, "Gate main's diagrams and code themes behind the code module") adds `/diagrams`, `/api/diagrams`, `/api/themes`, `/api/bridge/diagrams` and `/api/bridge/repos/:id/(overview|file)` to the `code` module in `moduleForPath`, and maps kind `diagram` → `code` in `moduleForKind`.
  - The same commit gates the assistant diagram and repo tools and the prompt rule (`agent.ts`, `registry.ts`, `state.ts`), entities (`routes/context.ts`), and the web: Make diagram, diagram links, the palette action, and the editor's New diagram item via `lib/use-module.ts`.
  - The sidebar already filters generically by `moduleForPath(href)`, and middleware refuses `/diagrams`, including when reached through `g d`.
  - Diagrams are now reachable only on templates that include Code.
- **Tool areas:** main's diagram and repo tools are area "context". Feature-2's area-to-module mapping alone would not have dropped them; fd14604 handles them explicitly.
- **Persona enum:** main didn't change `ActAs`, but both branches edit Settings in `shared-types/src/assistant.ts` (main adds `ideTheme`, feature-2 adds ActAs values). It's a textual merge, not a semantic clash.

### 3.5 Shareable code
- `DIAGRAM_TEMPLATES` (`packages/block-diagrams/src/templates.ts`) can become marketplace or desk "starters". For example, a Research desk could start with a mindmap and an Eng desk with an architecture diagram.
- `DiagramLink` (target kinds task/project/deliverable/repo) matches desk-starter seeding: `TemplateApplication` could create a diagram plus its links in the same transaction.
- `renderDiagramSvg` is DOM-free, so it can render thumbnails on the server for a **Diagrams desk widget** or marketplace preview cards without shipping xyflow, CodeMirror, jspdf or ELK to the client. `DiagramCard` already exists.
- ActAs/personas: main's `personaBlock` and `quickActions` are the base that feature-2 extends.
- Accent presets: both use `lib/accent.ts` presets (5).

---

## 4. Brand and design system on main

- **Logo:**
  - `apps/hub-web/components/mark.tsx` `Mark` is a constellation thread: an accent path plus 3 dots using `--accent-rgb` and `--ink-rgb`. It's used in the sidebar and the assistant dock. `Constellation` is the login art.
  - **Drift:** the favicon `app/icon.svg` is a 3-bar chart in #7c6af7 on #0c0d11, and legacy `.mark` bars CSS remains in `app/globals.css` L251–266. There's no `public/` directory.
- **Fonts** (`app/layout.tsx`, next/font/google):
  - Figtree: preloaded, `--font-sans`
  - Fraunces: **weight 500 only**, preload false, `--font-display-face`
  - JetBrains Mono: `display: optional`, preload false
  - CSS vars `--font-app`, `--font-display`, `--font-mono`. Font alternatives inter, plex, georgia and mono are in `components/settings/sections.tsx`.
- **Palette** (`app/globals.css`, 1,225 lines):

  | Token | Dark (`:root, [data-theme=dark]`) | Light (`[data-theme=light]`) |
  |---|---|---|
  | bg | #141210 | #f4f1ea |
  | sidebar | #1b1815 | |
  | panel | #221e1a | #fffcf7 |
  | raised | #2b261f | |
  | ink | #f3eee6 | #1c1915 |
  | muted | #b7ae9f | |
  | faint | #8f877b | |
  | accent | #7c6af7 | #5346d6 |
  | ok / warn / danger | #3cba86 / #e0a04a / #e36b64 | |

  - Dark also defines: hover; line 8%, line-strong 14%, tile-hover 20%; accent-fg/hover/soft/wash; edge; scrollbar; `--kind-{people,project,repo,task,deliverable,skill,note}`; `-rgb` triplets; tag-* pairs; `--diagram-line/dot/paper`.
  - Light mirrors the whole set.
  - Motion: `--ease` cubic-bezier(.2,.8,.2,1), `--dur-fast` 120 ms, `--dur` 180 ms. Reduced motion via both the media query and `[data-reduce-motion]`.
  - Component layer: `.tile` (1px line border, inset highlight), `.row-tile`, `.card`, `.btn`, `.chip`, `.kind-dot`, `.lift`, `.skeleton`. Diagram styles from L913.
  - **No `--elev-*`** (feature-2 adds `--elev-1/2`) and **no spacing or radius CSS tokens**.
- **Tailwind** (`apps/hub-web/tailwind.config.ts`): colours map to the CSS vars; radius lg 10px, xl 14px; shadow `pop`; fontFamily sans and mono.
- **Accent** (`lib/accent.ts`): presets indigo, tide, ember, rose and brass with dark and light hex. `resolveAccent` contrast-adjusts custom hex. `APPEARANCE_BOOT` is an inline script that avoids a flash.
- **VS Code themes vs app tokens** (`packages/ide-theme`):
  - 11 built-ins plus Ensemble Default. Open VSX themes come through `apps/hub-api/src/routes/themes.ts` and `themes/openvsx.ts` (open-vsx.org only, size caps, `.theme-cache`).
  - `convert.ts` `chromeVars` maps a VS Code theme onto app tokens: bg, panel, sidebar, raised, ink, muted, faint, line, line-strong, hover, ok, danger, warn, accent (plus -rgb/fg/hover/soft/wash), and ide-terminal/diff vars.
  - `IdeSpace` (`components/code/ide-theme.tsx`) sets them inline on its subtree. Inside Code review, the file editor and the diagram editor, **the IDE theme overrides the app palette and the user's accent**. The diagram canvas still follows the app theme, so one screen mixes two palettes.
  - Theme search and loading is called only from `components/code/ide-theme.tsx` and `theme-picker.tsx`, so gating `/api/themes` behind `code` (fd14604) breaks nothing outside Code and diagrams.

### 4.1 Drift against `/workspace/ensemble/mockups/SPEC.md`
| Mockup SPEC | Main (d2e73f6) | Action |
|---|---|---|
| `--a` / `--a-rgb` | `--accent` / `--accent-rgb` (+fg/soft/wash/hover) | Rename mockup tokens to main's |
| 8 accents (adds orchid, moss, sky) | 5 `AccentPreset`s | Add 3 presets to `lib/accent.ts` + shared-types, or drop them from the mockups |
| `--ink-2`, `--ghost` | Don't exist (main or feature-2) | Map to `--muted`/`--faint` or add |
| `--tile`, `--tile-top`, `--row` 72, `--gap` 12, `--r-inner` 9 | No spacing or radius vars; tailwind lg 10px | New tokens; reconcile 9 vs 10 |
| elevation tokens | None on main (feature-2 has `--elev-1/2`) | Adopt feature-2's |
| hover 14% | `--tile-hover` 20% | Pick one |
| omits `--kind-skill` | Main has `--kind-skill` | Keep |
| Fraunces "opsz/variable axis" | Static weight 500 only; mono `display: optional` | Load the variable font or fix the SPEC |
| Sidebar glyph = bars | In-app `Mark` = constellation; favicon = bars | Choose one brand mark; retire `.mark` CSS or the favicon |
| Diagram palette | Independent of desk accent (`packages/block-diagrams/src/palette.ts`) | Fine, but document |

---

## 5. Risks and opportunities

**Risks**
1. **Gating scope.**
   - fd14604 puts diagrams under `code`. Non-dev templates (student, teacher, researcher, lawyer…) lose mindmap, journey, timeline and org diagrams, which suit them well.
   - Users who switch templates keep `@diagram` cards embedded in pages. Those cards now point at refused routes. Check how the card node view degrades.
   - Decide: keep diagrams under code, make them core, or add a `diagrams` optional module.
2. **Hard delete.** No Trash or UndoEntry, and revisions cascade (`routes/diagrams.ts` DELETE). The assistant writes are marked `undoable` but aren't journaled (`lib/undo.ts`).
3. **Ctrl+Z on the canvas** fires the global task undo (`components/shell/topbar.tsx` L97–111).
4. **PUT `/api/diagrams/links`** doesn't verify that the target belongs to the user. It's harmless for reads (user-scoped), but it lets someone create dangling or foreign ids.
5. **Freshness N+1** (`routes/diagrams.ts` freshness). **Revision cap of 30 with 800 ms autosave** (`diagrams/history.ts`) means history is short.
6. **Bundle:** the `/diagrams/[id]` first load is 512 kB because jspdf (330 kB) loads eagerly. Import it dynamically at export time and it should drop to about 180 kB. ELK is 431 kB gz but already lazy.
7. **Merge surface:** about 28 shared files, plus the same-timestamp migrations. Don't rename the migrations.
8. **Graph gap:** diagrams and `DiagramLink` edges are missing from `/api/context/graph`.
9. **Brand drift:** favicon bars vs constellation `Mark`; mockup token names vs main's.
10. **Mixed palettes:** `IdeSpace` overrides the accent inside the diagram editor while the canvas uses the app theme.
11. **EPL-2.0** (elkjs) needs a licence note if the app is distributed.

**Opportunities**
1. **A "Diagrams" desk widget.** A recent or linked diagram, server-rendered via `renderDiagramSvg` (DOM-free), chosen through `DiagramLink` to the desk's project or tasks. It stays inside the widget budget because xyflow, CodeMirror, jspdf and ELK stay on the client editor route. Gate it with the same module as `/diagrams`.
2. **Marketplace and template starters.** Seed `DIAGRAM_TEMPLATES` per template (architecture for Eng, mindmap for Research, journey for Product, timeline for Aspirant). Use `TemplateApplication` to create the diagram plus links in one transaction.
3. **Gallery previews.** Reuse `renderDiagramSvg` for marketplace card art.
4. **Context graph.** Add diagram nodes and `DiagramLink` edges.
5. **Mockups.** Rename mockup tokens to main's names, and upstream `--elev`, spacing and radius tokens into `globals.css` and tailwind.
