# Web and CLI testing and production promotion

The live test Hub and its separate `ensemble-test` CLI are the team's feedback loop for UI, features and fixes. They use the same Hub/API/CLI source as production with isolated data and configuration. The web pipeline runs focused checks without desktop or cross-platform sandbox builds. Matching testing CLI packages build after the test site publishes, without delaying the web deployment. Production retains its full checks.

## Environments

| | Testing | Production |
| --- | --- | --- |
| Development/promotion branch | `testing` | `main` |
| API deployment pointer | `testing-live` | `production` |
| Hub | `https://test.ensemblework.com`, Vercel project `ensemble-test` | `https://app.ensemblework.com`, Vercel project `ensemble-app` |
| API | `https://api-test.ensemblework.com`, separate Cloudflare tunnel | `https://api.ensemblework.com` |
| Database, Redis, file container, state and encryption keys | Separate testing resources | Production resources |
| Cookies | `ENSEMBLE_COOKIE_NAMESPACE=testing` on API and web | Default namespace |
| Signup | Open, with the normal hosted verification, abuse limits and execution restrictions | Production signup policy |
| Model runtime | In-process API adapters (`ENSEMBLE_INPROCESS_RUNTIME=1`) | Configured production runtime |
| CLI | Separate `ensemble-test`, test backend only; `cli-testing-latest` prerelease | `ensemble`, production account and desktop-shared runtime; stable `cli-v*` releases |
| Ensemble Node website | `https://node-test.ensemblework.com`, Vercel project `ensemble-node-test`, from `ensemblework/ensemble-node` branch `testing`; marked Testing, not indexed | `https://node.ensemblework.com`, Vercel project `ensemble-node`, from its `main` |
| Native app, landing page | No testing releases or replica deployments | Existing release/deploy pipelines |

Each Node website talks only to its own API: the testing API's `ENSEMBLE_NODE_WEB_ORIGIN` names `node-test.`, production's names `node.`, and the Node build refuses settings that name the other environment's API or Hub. The Node repository has its own fast `test-web.yml` and promotion (its `docs/04`). Node's backend is this API's `node` module, so promote Ensemble before Node.

Testing copies released **code**, not production accounts, sessions, pages, connector credentials or uploaded files. Provider/email/Turnstile services are configured privately; OAuth and connector clients require callback URLs belonging to the testing API. Tests do not promote database contents back to production.

## Daily development

- Start web work from `testing`. A direct push to `testing`, or a feature PR targeting it, runs `test-web.yml`.
- The fast checks cover shared/API/web/CLI types, focused board/page/comment/motion regressions, namespaced authentication, CLI channel isolation, in-memory API isolation, deployment guards and the route inventory. The Vercel build remains a real production frontend build.
- A successful push advances `testing-live` without force. The isolated API pulls that pointer; the workflow waits for its exact commit and readiness before publishing only the test Vercel project.
- After the frontend publishes, `test-web.yml` calls `test-cli.yml` for macOS (Apple silicon/Intel), Linux (x64/arm64) and Windows x64 packages. It packages and smoke-tests the CLI/runner, not a native desktop UI. Publication rechecks `testing` and `testing-live` so an older build cannot replace a newer test snapshot.
- PRs targeting `testing` run checks but do not deploy. Production CI and desktop builds skip this PR target.
- Testing is shared integration work: changes can briefly interrupt the test site. Do not treat it as a backup or as a place for production customer data.

## Install the testing CLI

macOS and Linux:

```bash
curl -fsSL https://github.com/ensemblework/ensemble/releases/download/cli-testing-latest/install.sh | sh
ensemble-test login
```

Windows PowerShell:

```powershell
irm https://github.com/ensemblework/ensemble/releases/download/cli-testing-latest/install.ps1 | iex
ensemble-test login
```

Approve the code at `https://test.ensemblework.com/link`. Production uses `ensemble login` and the production website instead. A code, account or pairing from one environment cannot authorize the other. Add test work folders with `ensemble-test folders add <path>`; `ensemble-test runner install` installs a separate login service. `ensemble-test update` reads only the testing update manifest. `ensemble-test mcp setup` writes an `ensemble-test` editor entry without replacing `ensemble`.

The testing executable is compiled for `https://api-test.ensemblework.com`: `--api`, saved configuration, login replies and runner pairing cannot switch it to production. It ignores production `ENSEMBLE_API_URL`, tokens, config/data overrides and discovery files. Test-specific overrides are `ENSEMBLE_TEST_CONFIG_DIR`, `ENSEMBLE_TEST_DATA_HOME`, `ENSEMBLE_TEST_TOKEN` and `ENSEMBLE_TEST_API_URL` (the latter must still name the test API). Its database, encryption key, pairing, trusted folders, workspace, runtime lock, service and update cache are separate from the production CLI and native app. No production data migration runs. See [26 §1.1](26_CLI.md#11-testing-cli) for paths.

Testing downloads live in the GitHub `cli-testing-latest` **prerelease**, never Homebrew, Scoop, stable npm, stable CLI releases or the desktop updater. `channel.json` records the source commit, backend and unique `<release>-testing.<build>` version. All targets must pass their package smoke checks before the channel manifest is published. Versioned archives and checksums remain available while an earlier installer finishes.

## Promotion to production

Open a PR from `testing` to `main` when the work is ready. That PR runs the complete `ci.yml` and desktop checks. Merging triggers full CI on `main`; `deploy.yml` advances `production` and publishes the production API, Hub and landing page only after CI succeeds. Native/CLI releases keep their versioned tag requirements.

Bring the released `main` back into `testing` after promotion so the next test cycle starts from the released code. A production hotfix is also merged back into `testing`. Do not merge environment secrets, databases or deployment pointer branches.

## Implementation and safeguards

`.github/workflows/test-web.yml` owns fast checks and test deployment. Deployment is enabled by `TEST_DEPLOY_ENABLED=true`; it uses `ENSEMBLE_TEST_API_URL`, `VERCEL_PROJECT_ID_TEST` and the existing Vercel account credentials. No server secrets are uploaded to Vercel or GitHub.

`infra/deploy/testing/compose.yml` owns distinct Postgres/Redis containers and volume plus the test tunnel; `TEST_HOST_UID`/`TEST_HOST_GID` let the tunnel read its owner's private credential files. The `ensemble-test-api` user unit runs the API; `ensemble-test-deploy.timer` checks the reviewed deployment pointer every 30 seconds. `deploy.mjs` refuses production database/Redis endpoints, a missing cookie namespace, the production file container, shared state paths, enabled server execution or a Node website other than `node-test.ensemblework.com`. It fast-forwards, installs when dependency manifests changed, refreshes only the testing containers and user units, generates Prisma, dumps the test database before migrations, restarts only the test API and records success after readiness.

`ensembleCookieName` in `packages/shared-types/src/cookie-site.ts` applies the optional namespace consistently to session, active-space and OAuth-flow cookies. Middleware, server rendering and the API use the same names, so testing does not replace or clear production's cookies.

The test deploy also rejects an encryption key that is not 32 bytes encoded as base64, matching `lib/secrets.ts`. A passing liveness probe alone does not validate encrypted-credential or credit-accounting operations.

Operator-specific setup, credentials, service repair and DNS values belong in the git-ignored `private/HOSTING.md`.
