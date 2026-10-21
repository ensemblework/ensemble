# Branch desk demo

`pnpm seed:demo` fills one engineer desk: **Branch desk** (`branch-desk` / `mkt.branch-desk`). It is Mira Chen's workspace at Fieldnote, a small startup shipping Relay, a webhook delivery product for design partners. The other engineer templates (inbox triage, release desk, on-call morning, partner work, tech lead) are not seeded; `--desk` accepts only `branch`.

The account, if the command creates it:

- Email: `mira@fieldnote.dev`
- Password: `fieldnote-relay`

`--user <email>` attaches the same rows to an existing account instead. That switches the account onto the branch desk and turns the engineer modules on; it does not change the password.

| File | Role |
|---|---|
| `apps/hub-api/prisma/demo/branch-desk.json` | The story: people, tasks, meetings, diagram source, git files |
| `apps/hub-api/prisma/demo-branch.ts` | Loads it into Postgres and builds the local git repos |

## Load it

From the repo root, with `DATABASE_URL` set (copy `.env.example` to `.env`):

```bash
pnpm install
pnpm db:migrate     # prisma migrate deploy; never resets or deletes rows
pnpm seed:demo
pnpm dev
```

Sign in as Mira (or the `--user` account) and open Today. Sample mode is off, so the desk reads the database.

When `DATABASE_URL` points at `127.0.0.1` and nothing answers on 5432, the seed starts Postgres with Docker (`infra/docker-compose.yml`, as `pnpm infra:up`; `apps/hub-api/scripts/ensure-local-db.mjs`). `ENSEMBLE_SKIP_LOCAL_DB=1` or `CI` skips that.

The seed writes the git repos `fieldnote/relay` and `fieldnote/console` under `ENSEMBLE_WORKSPACE_ROOT`, where the Code tab looks. Point it at a writable folder and re-run the seed if you change it. Git must be on `PATH`; the seed runs `git init`.

Without Docker, use a local PostgreSQL 16 with a database named `ensemble` and set `DATABASE_URL` to it:

| OS | Setup |
|---|---|
| macOS | `brew install postgresql@16 && brew services start postgresql@16 && createdb ensemble`; `DATABASE_URL=postgresql://localhost:5432/ensemble` |
| Windows | The PostgreSQL 16 installer; create `ensemble`; run the commands above in PowerShell with Git for Windows on `PATH` |
| Linux | `sudo apt install postgresql postgresql-contrib git`, `sudo service postgresql start`, `sudo -u postgres createuser --pwprompt ensemble`, `sudo -u postgres createdb -O ensemble ensemble` |

## Re-run and remove

The seed can run again. It deletes the rows it owns (tasks and deliverables with `sourceRef` starting `demo:`, artifacts with `externalId` starting `demo:`, the Fieldnote projects, people, repos and skills, `model.call` events with `payload.demo = branch`, and the `fieldnote/` checkout) and writes them again.

```bash
pnpm seed:demo                            # reload
pnpm seed:demo -- --remove                # remove the demo, keep the account
pnpm seed:demo -- --user you@example.com  # attach to your account
```

## What the desk contains

- **Today:** four pull-request reviews (relay, sdk, console, infra), those four repos, checks, deploys, open issues other than the reviews, work in progress, a blocker and finished tasks.
- **Needs me:** a pull-request approval and a pending test command, showing time left in hours when more than about an hour and a half remains.
- **Code:** two local reviews, one still open.
- **Meeting notes and the weekly recap:** the Northwind drill and the signing review, one decision per line.
- **Metrics:** model calls across the last 14 days, fewer on weekends, each with a provider, token counts and a cost.
- **Skills:** the incident note, the signature review and the partner update.
- **Diagram:** the Relay path from ingress to the Northwind endpoint and the dead letter.

## Adding another desk

Use one JSON file per desk with one loader (or one loader that switches on `--desk`), and make each desk a different week of work rather than renamed branch rows. What the UI needs:

- A person with a job, a shared project and a repo the project links to; the graph, desk tiles and Context read those links.
- Tasks in every board status, with `taskType` set to what the live tile filters on (`review` for the branch hero). The Reviews tile lists only `review` tasks and Issues skips them, so rows do not show twice and the "waiting on you" count matches. A startup desk has three or four repos.
- `completedAt` inside the current week on done tasks and completed deliverables, or the weekly recap is empty. The recap reads meeting sessions, not meeting notes; notes still belong on Meeting notes. Write each decision on its own line with "decided" or "agreed", and do not repeat it in the recap: both fields are scanned, and a line with several decisions is truncated in the Decided list.
- A local git checkout with a committed baseline and an uncommitted edit on a branch (the Code tab diffs the working tree), at most two folders below `ENSEMBLE_WORKSPACE_ROOT`, or discovery misses it.
- Dates as offsets from now. Open tasks dated before today show as slipped in the recap and overdue on Today.
- One pending approval and one pending agent decision, or Needs me is blank. The countdown shows hours once more than about an hour and a half is left (`about 24 h`), so do not seed a one-day expiry as a raw minute string.
- `metric_events.kind = model.call` spread over the 14-day chart, with fewer calls on Saturday and Sunday in `America/Los_Angeles`. Each event needs `provider` (never `"unknown"`), `model`, `tokensIn` and `tokensOut`, and a model priced in `apps/hub-api/src/lib/pricing.ts`, or the cost shows a dash. Run steps and meeting extractions add to these; a step with null tokens, or an `extraction` without `tokensIn`/`tokensOut`, is left out. Deploys and test results are their own tables, not tasks.
- A tag on every owned row (`sourceRef`, `source`, slug, title) so a re-run deletes only the demo.

Pitfalls:

- Sample mode (`desk.sample`) hides the database and shows illustrated tiles; turn it off or the seed looks missing. Sample tiles (pull-request numbers, fake teammates) are sample-only; live tiles come from rows.
- Set both the signup template id (`branch-desk`) and the live desk id (`mkt.branch-desk`).
- Soft-deleted tasks show in Trash; done tasks show on Completed.
- Diagrams need `parseDiagram` output in `document`, not only a title.
- Re-seeding deletes projects by name; pick names that cannot collide with real projects, or scope the delete by the demo tag.
- Re-seeding must delete the tagged `model.call` events, or the chart doubles.
- In `pnpm dev` Next does not prefetch routes, so the first click compiles the page; a dev warm-up fetches routes after Today paints. Settings stays fast only while the page itself does not import the heavy sections, which load in later chunks.
