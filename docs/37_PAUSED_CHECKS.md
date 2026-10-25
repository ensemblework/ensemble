# 37 · Fast pipeline and paused checks

While development moves fast, every push and pull request into `testing` **and** `main` runs the same short set of checks, and production deploys right after them, the way testing always has. The slower suites are paused, not deleted: they live unchanged in `.github/workflows/full-checks.yml` and run by hand. This page lists what runs, what is paused and how to bring each back.

## What runs now

| Event | Workflow | What it does | Time |
| --- | --- | --- | --- |
| Push or PR to `testing` | `test-web.yml` | Fast checks; on a push, then the testing API, test web app and testing CLI ([36](36_WEB_TESTING.md)) | ~2 min to checks, ~5 min to a live test site |
| PR into `main` (a feature branch or `testing`) | `ci.yml` | Fast checks | ~2 min |
| Push to `main` | `ci.yml`, then `deploy.yml` | Fast checks; then `production`, the API, the Hub and the landing page ([01 §8](01_TECH_STACK_AND_ENVIRONMENT.md#8-ci-and-deploys)) | ~6 min to production |
| `cli-v<version>` tag | `cli-release.yml` | Builds on five targets, each packaged CLI smoke-run (seconds), `.deb`/`.rpm`, release, Homebrew and Scoop | ~10 min |
| `desktop-v<version>` tag, a push to `desktop`, or by hand | `desktop.yml` | Builds and publishes the installers on four targets; no tests | ~22 min (the Intel Mac build) |

The **fast checks** are one composite action, `.github/actions/fast-checks`, used by `ci.yml` (job *Typecheck and unit tests*) and `test-web.yml` (job *Web testing checks*): `pnpm version:check`, `pnpm db:generate`, typechecks of `shared-types`, `hub-api` (with its tests), `hub-web` and the CLI, the CLI channel-isolation tests, focused board, page, comment and session-cookie web tests, the in-memory page-board, cookie-namespace and production-guard API tests, the testing deploy guard, the release-script tests and the route inventory.

*Typecheck and unit tests* is the only required status check: on `main` (branch protection) and on the `production` branch (ruleset *production: only commits that passed CI*).

## Paused

Actions → **full-checks** → *Run workflow* runs all of these on any branch.

| Paused check | Covered | Took |
| --- | --- | --- |
| *Full typecheck and all unit tests* | `pnpm typecheck` across every package (landing, desktop, context bridge, quick capture included), brand, logo and icon checks, the `brand`, `shared-types`, `block-diagrams` and `ide-theme` tests, every `hub-web` test (plot tests with matplotlib) | ~4 min |
| *hub-api tests (Postgres + Redis)* | The whole `hub-api` suite against real Postgres and Redis (remote, desktop and engine end-to-end runs, sandboxed with Landlock), `pnpm bridge:verify` | ~8 min |
| *Sandbox escapes* (macOS Seatbelt, Linux Landlock, Linux bubblewrap, Windows) | Live escape attempts against each OS sandbox | ~1–2 min each, on four runners |
| *CLI tests and package smoke* | The CLI suite and a Linux package smoke | <1 min |
| *agent-runtime tests* | The Python runtime's `pytest` | ~2 min |
| *Production builds (Hub and landing)* | `next build` of both sites; Vercel builds them again at deploy | ~3 min |
| *macOS sandbox escapes* (`desktop-seatbelt`) | Escape, trust, planted-file and git-gate tests on macOS, and the Mac disk-image packager test | ~1.5 min |
| Desktop builds on pull requests | All four installers built for every PR into `main` | 12–26 min |

What this risks: a regression in those areas reaches production unnoticed; a Hub build error shows during `deploy.yml`, after the API has moved; a sandbox or platform break shows only on a release tag or in use. Run *full-checks* by hand before a risky change, and the locally runnable suites from `AGENTS.md`.

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
