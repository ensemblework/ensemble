# Web testing and production promotion

The live test Hub is the team's fast feedback loop for UI, features and fixes. It uses the same Hub and API code as production, with isolated data and configuration. The smaller test pipeline avoids desktop, CLI and cross-platform sandbox builds on each web iteration. Production retains its full checks.

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
| Native app, CLI, landing page, Ensemble Node website | No testing releases or replica deployments | Existing release/deploy pipelines |

Testing copies released **code**, not production accounts, sessions, pages, connector credentials or uploaded files. Provider/email/Turnstile services are configured privately; OAuth and connector clients require callback URLs belonging to the testing API. Tests do not promote database contents back to production.

## Daily development

- Start web work from `testing`. A direct push to `testing`, or a feature PR targeting it, runs `test-web.yml`.
- The fast checks cover shared/API/web types, focused board/page/comment/motion regressions, namespaced authentication, in-memory API isolation, deployment isolation guards and the route inventory. The Vercel build remains a real production frontend build.
- A successful push advances `testing-live` without force. The isolated API pulls that pointer; the workflow waits for its exact commit and readiness before publishing only the test Vercel project.
- PRs targeting `testing` run checks but do not deploy. Production CI and desktop builds skip this PR target.
- Testing is shared integration work: changes can briefly interrupt the test site. Do not treat it as a backup or as a place for production customer data.

## Promotion

Open a PR from `testing` to `main` when the work is ready. That PR runs the complete `ci.yml` and desktop checks. Merging triggers full CI on `main`; `deploy.yml` advances `production` and publishes the production API, Hub and landing page only after CI succeeds. Native/CLI releases keep their versioned tag requirements.

Bring the released `main` back into `testing` after promotion so the next test cycle starts from the released code. A production hotfix is also merged back into `testing`. Do not merge environment secrets, databases or deployment pointer branches.

## Implementation and safeguards

`.github/workflows/test-web.yml` owns fast checks and test deployment. Deployment is enabled by `TEST_DEPLOY_ENABLED=true`; it uses `ENSEMBLE_TEST_API_URL`, `VERCEL_PROJECT_ID_TEST` and the existing Vercel account credentials. No server secrets are uploaded to Vercel or GitHub.

`infra/deploy/testing/compose.yml` owns distinct Postgres/Redis containers and volume plus the test tunnel; `TEST_HOST_UID`/`TEST_HOST_GID` let the tunnel read its owner's private credential files. The `ensemble-test-api` user unit runs the API; `ensemble-test-deploy.timer` checks the reviewed deployment pointer every 30 seconds. `deploy.mjs` refuses production database/Redis endpoints, a missing cookie namespace, the production file container, shared state paths or enabled server execution. It fast-forwards, installs when dependency manifests changed, refreshes only the testing containers and user units, generates Prisma, dumps the test database before migrations, restarts only the test API and records success after readiness.

`ensembleCookieName` in `packages/shared-types/src/cookie-site.ts` applies the optional namespace consistently to session, active-space and OAuth-flow cookies. Middleware, server rendering and the API use the same names, so testing does not replace or clear production's cookies.

The test deploy also rejects an encryption key that is not 32 bytes encoded as base64, matching `lib/secrets.ts`. A passing liveness probe alone does not validate encrypted-credential or credit-accounting operations.

Operator-specific setup, credentials, service repair and DNS values belong in the git-ignored `private/HOSTING.md`.
