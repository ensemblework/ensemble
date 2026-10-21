# 04 · Personal skills and learning

Personal skills are editable, versioned Markdown instructions in the open Ensemble space. They tell the assistant and assigned agents how the person likes work done; they are not app actions (typed tools and playbooks do that, [11](11_HOW_THE_ASSISTANT_WORKS.md)).

The code is in `apps/hub-api`: `routes/skills.ts`, `jobs/skill-mining.ts`, `cowork/morning-skill.ts` and `assistant/tools/skills.ts`. `apps/skill-forge` is an empty Python package stub; there are no `forge:*` or `ensemble-forge` commands. Skills are the `skills` module.

## 1. Storage and editing

`Skill` holds the current body, name, slug, description, scope, enabled/deleted state and version; `SkillVersion` holds past bodies. Bodies live in the database, not in files. The API returns the newest **three** versions, current included (`KEEP_VERSIONS`), and a body edit deletes older ones.

The Skills page (`apps/hub-web/app/(hub)/skills`) autosaves the body 900 ms after typing stops. Each body change adds a version; restoring a version publishes it as a new version (the counter never goes back). Delete moves the skill to Trash. Disabled or deleted skills are never used, even if a task still links them.

`PATCH /api/skills/:id` locks the row; an optional `expectedVersion` that differs from the current version returns 409 "The skill changed. Read it again before editing." The Markdown body is what agents follow.

## 2. Using skills

| Consumer | What it gets |
|---|---|
| Workspace agent brief (`workspace/agent.ts`) | The task's linked enabled skills (`skillIds`), or all enabled skills when none are linked; up to 6, each body cut to 900 characters |
| Context Bridge brief (`bridge/service.ts`, `rankSkills`) | Enabled skills ranked: linked on the task +5, scope mentions the repository +3, the project +2, the task type +2. The top 3 with a score (else the top 3), bodies excerpted to 1,800 characters. Only current bodies; version history is never exposed |
| Hub assistant (`assistant/state.ts`) | The names of enabled skills; it reads a body with `hub_read_skill` when one applies |

Runs do not record which skills were used: `Run.skillIds` and `Run.skillSignatures` exist in the schema but are not written.

A skill is guidance, never a permission, credential or schedule.

## 3. Morning brief skill

`cowork/morning-skill.ts` creates the `morning-brief` skill from profession defaults. `/morning-brief` edits it with normal versioning. The first delivered brief offers personalization once per account; dismissing, saving or later deliveries do not bring the offer back.

Scheduled delivery starts on the local day after account creation and runs at most once per local day. Local delivery needs the local/desktop runtime running. Preview uses current Today context and the saved skill; it sends no messages and takes no calendar actions.

## 4. Completed-work learning

`jobs/skill-mining.ts` runs inside the daily retention pass:

1. Select eligible, unpinned completed tasks and deliverables, at most 50 of each per batch.
2. Give at least **24 hours' notice** (a notification) before learning from the work and moving it to Trash. Pinning an item in Completed keeps it out.
3. Call the person's **High** model with bounded evidence (descriptions and notes up to 1,500 characters each) and current skill bodies.
4. Validate the structured result. New guidance for an existing skill is appended under `## Learned from completed work` as a new version; new slugs become new skills. The miner never changes `morning-brief`.
5. Write completion summaries and move the batch to Trash in the same transaction as the skill changes.

An empty result is fine. A failed model, a skill edited or deleted meanwhile, a reopened or pinned record, or an active job keeps the work for a later pass. The notice state is the per-space `hub.retention-mining` preference. Trash purge then follows its own retention window ([07 §1.1](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#11-completed-and-deleted-data-retention)).

Learned changes are published directly after the notice; there is no review/accept step. There is no bulk mining of history at first run, no mailbox mining and no automatic creation of scheduled workflows.

## 5. Assistant management

| Request | Tool |
| --- | --- |
| Find current or disabled skills | `hub_list_skills` |
| Read a body in chunks, with retained version metadata | `hub_read_skill` |
| Create, update (body/name/description/enabled), restore a version or delete | `hub_manage_skill` |

`hub_manage_skill` waits for Apply and uses the skill routes; updates pass `expectedVersion` from `hub_read_skill`, and creation takes the initial body. These tools never start a preview or mining pass.

## 6. API

| Method | Route | Behaviour |
| --- | --- | --- |
| GET | `/api/skills`, `/api/skills/:id` | Current records with up to three retained versions |
| POST | `/api/skills` | Create, optionally with an initial body |
| PATCH | `/api/skills/:id` | Edit name/description/body/enabled; optional `expectedVersion` |
| POST | `/api/skills/:id/restore` | Publish a retained version as a new version |
| POST | `/api/skills/:id/test` | Sample output from the Easy model; no tools, no external actions; needs a verified account; normal usage applies |
| POST | `/api/skills/:id/score` | Check a `draft` against the skill's rule lines |
| DELETE | `/api/skills/:id` | Move to Trash |

`/score` reads bullet lines in the body of the form `- must-include: …`, `- must-not-include: …`, `- max-words: N` and `- min-words: N`, and reports pass/fail for each. It is a literal text check, not a quality judgement.

## 7. Privacy and tests

Skills are space-scoped and follow module and sharing access. Bodies can hold private instructions and learned guidance from the person's work; they are not anonymized. Export, deletion and Trash work as for other data.

Tests (under `apps/hub-api/src`): `jobs/retention.integration.test.ts` (mining with a fixture model), `test/resources.integration.test.ts` and `test/testing-report.integration.test.ts` (skill routes), `assistant/workspace-actions.integration.test.ts` (skill tools). They use fixture models, so they cover versioning and retention, not the quality of a live model's output.
