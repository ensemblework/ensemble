# 37 · Fast pipeline and paused checks

Run the local checks for the area you changed. Pushes and pull requests into `testing` and `main` run the same fast checks automatically. Before a risky change, open **Actions → full-checks → Run workflow** and choose the branch to verify.

The tables below show what runs automatically and what requires that manual workflow. Production deploys after the fast checks pass. Longer tests and platform builds do not run on every change.

## What runs now

| Event | Workflow | What it does | Time |
| --- | --- | --- | --- |
| Push or PR to `testing` | `test-web.yml` | Fast checks; on a push, then the testing API, the test web app (when something the Hub is built from changed) and testing CLI ([36](36_WEB_TESTING.md)) | ~3 min to checks, ~6 min to a live test site |
| PR into `main` (a feature branch or `testing`) | `ci.yml` | Fast checks, in four parallel parts | ~2 min |
| Push to `main` | `ci.yml`, then `deploy.yml` | Fast checks; then `production`, the API, the Hub and the landing page ([01 §8](01_TECH_STACK_AND_ENVIRONMENT.md#8-ci-and-deploys)) | ~2 min of checks, then the deploy |
| `cli-v<version>` tag | `cli-release.yml` | Builds on six targets, each packaged CLI smoke-run (on Windows `install.ps1` too), `.deb`/`.rpm`, release, Homebrew and Scoop | ~18 min (the Windows on Arm build) |
| `desktop-v<version>` tag, a push to `desktop`, or by hand | `desktop.yml` | Builds and publishes the installers on six targets; no tests | ~22 min (the Intel Mac build) |
| Push to `main` | Cloudflare Workers Builds (Worker `ensemble-docs`, outside GitHub Actions) | Builds `apps/docs` and publishes `docs.ensemblework.com` ([40](40_PUBLIC_DOCUMENTATION.md#2-build-and-hosting)) | A few minutes |

The **fast checks** are one composite action, `.github/actions/fast-checks`. `ci.yml` runs it as four parallel jobs, one per `part`: *Fast checks (types)*, *(regressions)*, *(sessions)* and *(rest)*, about two minutes in all. Then *Typecheck and unit tests* passes only when all four passed. `test-web.yml` runs every step in one job, *Web testing checks*. Every part installs dependencies and generates the Prisma client (`pnpm db:generate`) first. Its fixtures are in memory (PGlite) or local: no paid model, vendor directory or real agent account is used.

| Step | Part | Covers |
| --- | --- | --- |
| Versions and types | `types` | `pnpm version:check`, typechecks of `shared-types`, `prompts`, `hub-api`, `hub-web` and the CLI |
| CLI channel boundaries | `rest` | The testing CLI's isolation (channel, paths, sign-in, editor MCP setup, launcher and updates) and the API's client channel |
| Published docs and read-only lookup | `rest` | Builds `apps/docs` and tests its theme assets, reader coverage, links, extracts, explicit misses and docs helper (grounding, medium effort, scope guards, guest non-persistence, signed-in history isolation and clear races), plus shared launcher/resize contracts, and `ensemble_docs` through the bridge and hosted MCP ([40](40_PUBLIC_DOCUMENTATION.md)) |
| Focused web and API regressions | `regressions` | Run previews, board drag and insights, Pages, comments, the connector store, the morning brief and its prompt, sign-in and session cookies, page boards, cookie namespaces, production guards, Node's file workspace and file changes, run checkout folder names, confirmed session deletion, starting the runner's login service |
| Sessions, Node plans and agent apps | `sessions` | Filing and titling sessions in the agents' apps, a deleted project's Codex projects, sessions used outside Ensemble (what the person said in the agent's app brought into chats and runs, and their own project sessions listed), sessions an agent's app holds and why a session restarted, a sub-agent's events kept out of its session's answer, chats' named folders, ask sessions, deleting chats and projects, summaries, one runtime per computer (the runtime lock, and turns, relayed requests and event streams going to one runtime), the local database in UTC on a computer in another zone, Node's plans, routing, schedules, dispatch and instructions (each condition's section, and a node's instructions staying the same for its session on its owner's AI plan), and the AI subscriptions' detection, sign-in commands and Set up for an agent's app without its agent (the API, the tiles and `ensemble doctor`) |
| Active places and conditional saves | `rest` | Three-place admission, release and replacement, key exemption, field-level save merges and conflicts, the Hub's chooser and conflict dialog |
| Sandbox beta, off by default | `rest` | The sandbox's defaults (Sandbox by default, run profiles, Quick, the assign request), the one-time switch-off of saved settings on PGlite, a computer's sandbox rule for web tasks, Antigravity assigned from the assistant without the sandbox, the Beta tag in Settings ([24 §1](24_DESKTOP_SANDBOXING.md#1-the-os-sandbox-is-in-beta)) |
| MCP OAuth, named tools and consent | `rest` | The bridge's typecheck and catalog, OAuth discovery, consent, PKCE, client and resource binding, refresh and revocation, named and legacy tools, the consent and sign-in forms and their routes ([Context Bridge](CONTEXT_BRIDGE.md)) |
| Included model defaults and credit-safe search | `rest` | Included model defaults, pricing, the credit budget, the included runtime, web search and Node's model choice ([33](33_INCLUDED_AI.md)) |
| Deployment guards, release scripts, route and test inventories and prompt sections | `rest` | The testing deploy guard, the desktop release, version and target scripts, Prisma's Rust-free client on PGlite (the Windows arm64 sidecar, [DESKTOP §6](DESKTOP.md#6-build-and-package)), `route:inventory:check`, `test:inventory:check` (every `hub-api` test file is named in a package script, by path or glob, or is on the skip list in `apps/hub-api/scripts/test-inventory.ts` with the reason it runs nowhere), and the `prompts` tests (the generated module matches the section files, [README](../packages/prompts/README.md)) |

*Typecheck and unit tests*, `ci.yml`'s summary job, is the only required status check: on `main` (branch protection) and on the `production` branch (ruleset *production: only commits that passed CI*).

## Paused

Actions → **full-checks** → *Run workflow* runs all of these on any branch.

| Manual check | Covers | Typical time |
| --- | --- | --- |
| *Full typecheck and all unit tests* | `pnpm typecheck` across every package (landing, desktop, context bridge, quick capture included), brand, logo and icon checks, the `brand`, `shared-types`, `prompts`, `block-diagrams` and `ide-theme` tests, every `hub-web` test (plot tests with matplotlib) | ~4 min |
| *hub-api tests (Postgres + Redis)* | The whole `hub-api` suite against real Postgres and Redis (remote, desktop and engine end-to-end runs, sandboxed with Landlock), `pnpm bridge:verify` | ~8 min |
| *Sandbox escapes* (macOS Seatbelt, Linux Landlock, Linux bubblewrap, Windows) | Live escape attempts against each OS sandbox | ~1–2 min each, on four runners |
| *CLI tests and package smoke* | The CLI suite and a Linux package smoke | <1 min |
| *agent-runtime tests* | The Python runtime's `pytest` | ~2 min |
| *Production builds (Hub and landing)* | `next build` of both sites; Vercel builds them again at deploy | ~3 min |
| *macOS sandbox escapes* (`desktop-seatbelt`) | Escape, trust, planted-file and git-gate tests on macOS, and the Mac disk-image packager test | ~1.5 min |
| Desktop builds on pull requests | Every desktop target's installers built for every PR into `main` | 12–26 min |

A regression outside the fast checks can reach production. A Hub build error appears during deployment, after the API has moved. A sandbox or platform problem can first appear in a release build or during use.

Run **full-checks** before a risky change, plus the relevant local suites in `AGENTS.md`.

## In the code

The manual suites live in `.github/workflows/full-checks.yml`. Keep workflow job names and branch protections in sync when changing which checks are automatic.

## Bringing them back

1. **Automatic again.** Move a job from `full-checks.yml` back under `jobs:` in `ci.yml` (it keeps its name). For the desktop: move `desktop-seatbelt` back into `desktop.yml` as `seatbelt` with its `if: ${{ !inputs.recovery_source_run && !inputs.recovery_intel_run }}`, and add `pull_request: { branches-ignore: [testing] }` to its triggers. Rename *Full typecheck and all unit tests* back to *Typecheck and unit tests* if it replaces the fast job, or keep both.
2. **Required again.** Add each job's name on both protections. On `main`:

   ```bash
   gh api -X PATCH repos/ensemblework/ensemble/branches/main/protection/required_status_checks \
     -F strict=false -f 'contexts[]=Typecheck and unit tests' -f 'contexts[]=hub-api tests (Postgres + Redis)' \
     -f 'contexts[]=CLI tests and package smoke' -f 'contexts[]=agent-runtime tests' \
     -f 'contexts[]=Production builds (Hub and landing)' -f 'contexts[]=Sandbox escapes (macOS Seatbelt)' \
     -f 'contexts[]=Sandbox escapes (Linux Landlock)' -f 'contexts[]=Sandbox escapes (Linux bubblewrap)' \
     -f 'contexts[]=Sandbox escapes (Windows sandbox account)'
   ```

   On `production`: Settings → Rules → *production: only commits that passed CI* → *Require status checks to pass*, the same names. A name that is required but no longer reported blocks every merge and every deploy, so change the workflow and the protections together.
