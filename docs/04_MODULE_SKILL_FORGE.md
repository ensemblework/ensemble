# 04 · Personal skills and learning

Personal skills are editable, versioned Markdown instructions in the open Ensemble space. They tell the assistant and assigned agents how the person likes work done; they are not app actions (typed tools and playbooks do that, [11](11_HOW_THE_ASSISTANT_WORKS.md)).

The code is in `apps/hub-api`: `routes/skills.ts`, `jobs/skill-mining.ts` and `assistant/tools/skills.ts`. `apps/skill-forge` is an empty Python package stub; there are no `forge:*` or `ensemble-forge` commands. Skills are the `skills` module.

## 1. Storage and editing

`Skill` holds the current body, name, slug, description, scope, enabled/deleted state and version; `SkillVersion` holds past bodies. Bodies live in the database, not in files. The API returns the newest **three** versions, current included (`KEEP_VERSIONS`), and a body edit deletes older ones.

The Skills page (`apps/hub-web/app/(hub)/skills`) autosaves the body 900 ms after typing stops. Each body change adds a version; restoring a version publishes it as a new version (the counter never goes back). Delete moves the skill to Trash. Disabled or deleted skills are never used, even if a task still links them.

The UI keeps the editor, enablement, history and any recorded evidence. It does not expose test/score controls or an unfinished learning promotion. The test and score API routes remain available to clients (§6).

`PATCH /api/skills/:id` locks the row; an optional `expectedVersion` that differs from the current version returns 409 "The skill changed. Read it again before editing." The Markdown body is what agents follow.

## 2. Using skills

| Consumer | What it gets |
|---|---|
| Workspace agent brief (`workspace/agent.ts`) | Only the skills linked to the task (`skillIds`), never one with a dedicated `scope.purpose`; up to 6, each body cut to 900 characters |
| Context Bridge brief (`bridge/service.ts`, `rankSkills`) | Enabled skills ranked: linked on the task +5, scope mentions the repository +3, the project +2, the task type +2. The top 3 with a score (else the top 3), bodies excerpted to 1,800 characters. Only current bodies; version history is never exposed |
| Hub assistant (`assistant/state.ts`) | The names and descriptions of enabled skills (up to 12, not one with `scope.purpose`) in its instructions; it reads a body with `hub_read_skill` when one applies |

Runs do not record which skills were used: `Run.skillIds` and `Run.skillSignatures` exist in the schema but are not written.

A skill is guidance, never a permission, credential or schedule.

## 3. Morning brief instructions

Morning brief is the account's built-in assistant routine, not a personal skill. `cowork/morning-skill.ts` supplies profession-default instructions to `routines/service.ts` at signup. The authoritative body is `AssistantRoutine.instruction`, edited with the schedule and pause on `/routines`. Routine runs use the account's default assistant model and keep their replies in one conversation. Details: [02 §3.10a](02_MODULE_INTERACTION_HUB_UI.md#310a-routines).

## 4. Completed-work learning

`jobs/skill-mining.ts` runs inside the daily retention pass:

1. Wait for a batch: nothing starts until at least **10** unpinned completed tasks and deliverables (`SKILL_LEARNING_MIN_ITEMS`) are past the completed window (a day early, for the notice). A batch takes the oldest, at most 50 of each.
2. Give at least **24 hours' notice** (a notification naming the model) before learning from the work and moving it to Trash. Pinning an item in Completed keeps it out.
3. Call the model Settings → Automations → *Learn personal skills from completed work* names (`automations.skillLearning.tier`, High by default) with bounded evidence and the current skill bodies. Each item brings its title, type, labels, project, description, notes and page text, the latest finished run's report (its summary and the kinds of results) and what the person wrote for it themselves (their messages, emails or pull request texts linked to the task), within a 90,000-character budget. That is where how they write PR descriptions or emails is learned from.
4. Validate the structured result. New guidance for an existing skill is appended under `## Learned from completed work` as a new version; new slugs become new skills. The miner never edits routines or creates a skill with the reserved slug `morning-brief`.
5. Write completion summaries and move the batch to Trash in the same transaction as the skill changes. The notification says how many skills changed and, when a fallback answered, which model.

**When the model cannot answer.** A model that is an AI plan on the person's computer is checked first (`pickComputer`): offline, not signed in or not installed counts as unavailable, as does any failed call. The batch then waits and says so (one notification, then at most one every 3 days, `waitingSince`/`noticeAt` on the batch). After **5 days** of waiting (`SKILL_LEARNING_WAIT_DAYS`) each pass tries the lower tiers in turn (High → Medium → Easy, skipping ones with the same model), then a model included with the person's Ensemble account (`includedConfig()`, or the paired desktop's included catalogue; none in local-only mode), and the notification names the one that answered. Until one does, the work stays in Completed.

**Off.** With learning off (`skillLearning.enabled: false`), work past the window moves to Trash without any model call, a batch threshold or a notice.

An empty result is fine. A skill edited or deleted meanwhile, a reopened or pinned record, or an active job keeps the work for a later pass. The notice state is the per-space `hub.retention-mining` preference. Trash purge then follows its own retention window ([07 §1.1](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#11-completed-and-deleted-data-retention)). The daily pass runs for each account on its own, so one waiting model never holds up anyone else's.

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
