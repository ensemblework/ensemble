# Branch desk demo

One engineer desk is filled: **Branch desk** (`branch-desk` / `mkt.branch-desk`). It is Mira Chen’s workspace at Fieldnote, a small startup shipping Relay, a webhook delivery product for design partners. The other engineer templates (inbox triage, release desk, on-call morning, partner work) are not seeded. Notes for building them are at the bottom.

The account, if this command creates it:

- Email: `mira@fieldnote.dev`
- Password: `fieldnote-relay`

Pass `--user` to attach the same rows to an account you already have. That switches the account onto the branch desk and turns the engineer modules on. It does not change an existing password.

## Load it

From the repo root, with Postgres running and `DATABASE_URL` set (copy `.env.example` to `.env` if you have not).

```bash
pnpm install
pnpm db:migrate
pnpm seed:demo
pnpm dev
```

Sign in as Mira, or as the email you passed. Open Today. Sample mode is off, so the desk reads the database.

`pnpm db:migrate` applies pending Prisma migrations with `prisma migrate deploy` (it loads the repo-root `.env`). It does not prompt for `migrate reset` and it does not delete rows.

### Mac

```bash
brew install postgresql@16
brew services start postgresql@16
createdb ensemble
# DATABASE_URL=postgresql://localhost:5432/ensemble
pnpm install
pnpm db:migrate
pnpm seed:demo
```

The Code tab looks for git repos under `ENSEMBLE_WORKSPACE_ROOT` (default in `.env.example`). The seed writes `fieldnote/relay` and `fieldnote/console` there. Point that variable at a folder you can write, then re-run the seed if you change it.

### Windows

Install PostgreSQL 16 from the installer, create a database named `ensemble`, and set `DATABASE_URL` in `.env`. Use PowerShell from the repo root:

```powershell
pnpm install
pnpm db:migrate
pnpm seed:demo
```

Git for Windows has to be on `PATH`. The seed runs `git init` in the workspace folder.

### Linux

```bash
sudo apt install postgresql postgresql-contrib git
sudo service postgresql start
sudo -u postgres createuser --pwprompt ensemble
sudo -u postgres createdb -O ensemble ensemble
pnpm install
pnpm db:migrate
pnpm seed:demo
```

Set `DATABASE_URL` to the role you created.

## Reset

The seed is safe to run again. It deletes rows it owns (task `sourceRef` starting with `demo:`, the Fieldnote projects, people, repos, skills, and the `fieldnote/` checkout) and writes them again.

```bash
pnpm seed:demo
```

Remove the demo and leave the account in place:

```bash
pnpm seed:demo -- --remove
```

Attach it to the account you use locally:

```bash
pnpm seed:demo -- --user you@example.com
```

`--desk` only accepts `branch`.

Files:

- `apps/hub-api/prisma/demo/branch-desk.json` — the story (people, tasks, meetings, diagram source, git files)
- `apps/hub-api/prisma/demo-branch.ts` — loads that file into Postgres and builds the local git repos

## What the desk contains

Today shows four pull-request reviews (relay, sdk, console, infra), those four repos, checks, deploys, open issues that are not the reviews, work in progress, a blocker, and finished tasks. Needs me has a pull-request approval and a pending test command, with the time left in hours when it is more than an hour and a half. Code has two local reviews, one still open. Meeting notes and the weekly recap share the Northwind drill and the signing review, one decision per line. Metrics has model calls across the last 14 days, quieter on weekends, each with a provider, token counts, and a cost. Skills are the incident note, the signature review, and the partner update. The block diagram is the Relay path from ingress to the Northwind endpoint and the dead letter.

## Building the other engineer desks later

Keep one JSON file per desk and one loader, or one loader that switches on `--desk`. Do not copy the branch rows and rename them. Each desk should be a different week of work.

Structure that held up:

- A person with a job, a project they share, and a repo that project links to. The graph, the desk tiles, and Context all read those links.
- Tasks in every status the board shows, with `taskType` set to what the live tile filters on (`review` for the branch hero). A status alone is not enough. The Reviews tile lists only `review` tasks, and Issues skips those, or the same rows show twice and the “waiting on you” count does not match the list. Give a startup desk three or four repos, not one.
- `completedAt` on done tasks and completed deliverables, inside the current week, or the weekly recap stays empty. Recap reads meeting sessions, not meeting notes. Notes still belong on the Meeting notes page. Put each decision on its own line with “decided” or “agreed”. Do not repeat that sentence in the recap: both fields are scanned, and a line that packs several decisions is truncated in the Decided list.
- A local git checkout with a base commit and an uncommitted edit on a branch. The Code tab diffs the working tree. Commit the baseline first, then write the edit. Store the repo under `ENSEMBLE_WORKSPACE_ROOT` within two folders of the root, or discovery will not see it.
- Dates as offsets from “now”, not a fixed calendar day. A seed that says 12 March looks stale in October, and a Monday has no earlier day in the current week for “slipped”.
- One pending approval and one pending agent decision, or Needs me is blank. The countdown is hours once more than about an hour and a half is left (`about 24 h`), so a one-day expiry should not be seeded as a raw minute string.
- Metrics wants `metric_events.kind = model.call` spread across the 14-day chart, with fewer calls on Saturday and Sunday in `America/Los_Angeles`. Every event needs `provider`, `model`, `tokensIn`, `tokensOut`, and a model whose list price is in `apps/hub-api/src/lib/pricing.ts` or the cost renders as a dash. Run steps and meeting extractions are added on top of those events. A step with null tokens, or a note whose `extraction` JSON has no `tokensIn` / `tokensOut`, is omitted. Do not leave `provider: "unknown"`. Deploys and test results are their own tables, not tasks.
- Tag every owned row (`sourceRef`, `source`, slug, title) so a second run can delete just the demo.

Pitfalls:

- Sample mode (`desk.sample`) hides the database and shows the illustrated tiles. Turn it off or the seed looks missing.
- The signup template id is `branch-desk`. The live desk id is `mkt.branch-desk`. Set both.
- Soft-deleted tasks show in Trash, not on the board. Done tasks show on Completed. Do not use Trash as the done column.
- Diagrams need `parseDiagram` output in `document`, not only a title.
- Re-seeding deletes projects by name. Pick names that will not collide with someone’s real project, or scope the delete with the demo tag.
- The illustrated sample tiles (pull-request numbers, fake teammates) are sample mode only. Live tiles must come from rows. Do not put those numbers in the seed and also leave sample mode on.
- Re-seeding must delete `model.call` events tagged `payload.demo = branch`, or the chart doubles every run.
- In `pnpm dev`, Next does not prefetch routes. The first click compiles the page. Settings stays fast only if the page itself does not import the heavy sections (those load in later chunks). A dev warm-up fetches the routes after Today paints.
