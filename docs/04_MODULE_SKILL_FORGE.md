# 04 · Personal skills and learning

Write a personal skill to tell the assistant and assigned agents how you like work done. Open **Skills** in the space where you want to use it, then edit its Markdown instructions. Skills keep version history. App actions use typed tools and playbooks instead ([11](11_HOW_THE_ASSISTANT_WORKS.md)).

Ensemble Node also comes with Ensemble's own skills (planning, checking work before saying it is done, debugging, research, shopping and more, §2.1). Your enabled personal skills join them: a node lists the ones that fit your message, gets the best one in full when your words call for it plainly, and reads any other in full when it starts that kind of work. A personal skill with the same name as one of Ensemble's replaces it for your nodes.

## 1. Storage and editing

Edit the body on the Skills page. It saves 900 ms after you stop typing. Each body change creates a version; the newest **three** versions are kept, including the current one. Editing the body removes older versions.

Open history to restore a retained version. Restoring publishes it as a new version, so the version counter keeps increasing. Disable a skill to stop using it. The Skills page's delete button appears on hover or keyboard focus, and is always visible on touch devices. Delete permanently removes the skill, its retained versions and feedback immediately, without a confirmation popup, retention window or Undo. A disabled or deleted skill is ignored even when a task still links to it.

The UI keeps the editor, enablement, history and any recorded evidence. It does not expose test/score controls or an unfinished learning promotion. The test and score API routes remain available to clients (§6).

`PATCH /api/skills/:id` locks the row. Hub edits include `_base`: disjoint fields merge, and overlapping changes return 409 `SAVE_CONFLICT` for the person to choose ([02 §5](02_MODULE_INTERACTION_HUB_UI.md#5-state--data-flow)). Without `_base`, an optional `expectedVersion` that differs from the current version returns 409 "The skill changed.

Read it again before editing." The Markdown body is what agents follow.

## 2. Using skills

| Consumer | What it gets |
|---|---|
| Workspace agent brief (`workspace/agent.ts`) | Only the skills linked to the task (`skillIds`), never one with a dedicated `scope.purpose`; up to 6, each body cut to 900 characters |
| Context Bridge brief (`bridge/service.ts`, `rankSkills`) | Enabled skills ranked: linked on the task +5, scope mentions the repository +3, the project +2, the task type +2. The top 3 with a score (else the top 3), bodies excerpted to 1,800 characters. Only current bodies; version history is never exposed |
| Hub assistant (`assistant/state.ts`) | The names and descriptions of enabled skills (up to 12, not one with `scope.purpose`) in its instructions; it reads a body with `hub_read_skill` when one applies |
| Ensemble Node (`node/skills.ts`) | One catalogue with Ensemble's bundled skills (§2.1): the enabled skills (not one with `scope.purpose`) whose name, description or first 1,000 characters share words with the turn's request, one line each, in a turn its owner started and reads alone, and the best one's body in full (up to 1,500 characters) when the request has its keywords or name; `node_skill` reads one in full by its name ([35 §5.6](35_ENSEMBLE_NODE.md#56-context-db-memory-and-skills-implementation-reference)). Node turns leave the assistant's own list out |

Workspace runs record the supplied skills' ids and content signatures in `Run.skillIds` and `Run.skillSignatures`, including an explicit empty list when none were supplied. The instruction fingerprint and linked context pack keep their provenance ([06 §4](06_MODULE_WORKSPACE_AND_SURFACES.md#4-evidence-and-review)).

A skill is guidance, never a permission, credential or schedule.

### 2.1 Ensemble's bundled skills

Ensemble's own skills are `SKILL.md` files in the repository's `skills/<name>/` folder, written in Ensemble's words. Each has the frontmatter every agent harness reads: `name` (the folder's name), `description` (when to use it, starting "Use when", under 500 characters), `license`, and `metadata` with `priority` (`p0` for the process skills), `keywords` (the words and phrases that call for it), `tools` (it is offered only when the turn has one of them; none: always) and `source` (where its method comes from; adapted MIT texts are listed in `THIRD_PARTY_NOTICES`). The body is the guidance, as lines to follow, with no headings.

| Priority | Skills |
| --- | --- |
| p0 (process) | `planning`, `verify-before-done`, `clarify-intent`, `debugging`, `delegation`, `independent-review`, `stuck-recovery` |
| p1 | `research`, `writing`, `connected-apps`, `browser-tasks`, `desktop-tasks`, `recording`, `memory-notes`, `routine-design`, `shopping`, `screenshots`, `sign-in`, `web-files`, `web-task` |

`packages/prompts` embeds them at build time (`scripts/generate.mjs` writes `src/skills.generated.ts`, exported as `SKILLS`), so the API, the desktop sidecar and the CLI read no file at run time; the generator refuses a skill whose frontmatter or wording breaks these rules, and `pnpm prompts:check` fails while the module is out of date. Each bundled skill's body fits the 1,500 characters a node gets in full (`src/node/skills.test.ts` checks it). Ensemble Node chooses among them for each turn ([35 §5.6](35_ENSEMBLE_NODE.md#56-context-db-memory-and-skills-implementation-reference)).

## 3. Morning brief instructions

Open **Routines** at `/routines` to edit Morning brief's instructions, schedule or pause. Morning brief is the account's built-in assistant routine. Its starting instructions follow your profession. Runs use your default assistant model and keep their replies in one conversation. Details: [02 §3.10a](02_MODULE_INTERACTION_HUB_UI.md#310a-routines).

## 4. Completed-work learning

Choose the model in **Settings → Automations → Learn personal skills from completed work**. High is the default tier. When learning is on, the daily retention pass works as follows:

1. Wait for a batch: nothing starts until at least **10** unpinned completed tasks and deliverables (`SKILL_LEARNING_MIN_ITEMS`) are past the completed window (a day early, for the notice). A batch takes the oldest, at most 50 of each.
2. Give at least **24 hours' notice** (a notification naming the model) before learning from the work and moving it to Trash. Pinning an item in Completed keeps it out.
3. Call the model Settings → Automations → *Learn personal skills from completed work* names (`automations.skillLearning.tier`, High by default) with bounded evidence and the current skill bodies. Each item brings its title, type, labels, project, description, notes and page text, the latest finished run's report (its summary and the kinds of results) and what the person wrote for it themselves (their messages, emails or pull request texts linked to the task), within a 90,000-character budget. That is where how they write PR descriptions or emails is learned from.
4. Validate the structured result. New guidance for an existing skill is appended under `## Learned from completed work` as a new version; new slugs become new skills. The miner never edits routines or creates a skill with the reserved slug `morning-brief`.
5. Write completion summaries and move the batch to Trash in the same transaction as the skill changes. The notification says how many skills changed and, when a fallback answered, which model.

**When the model cannot answer.** A model that is an AI plan on the person's computer is checked first (`pickComputer`): offline, not signed in or not installed counts as unavailable, as does any failed call. The batch then waits and says so (one notification, then at most one every 3 days, `waitingSince`/`noticeAt` on the batch).

After **5 days** of waiting (`SKILL_LEARNING_WAIT_DAYS`) each pass tries the lower tiers in turn (High → Medium → Easy, skipping ones with the same model), then a model included with the person's Ensemble account (`includedConfig()`, or the paired desktop's included catalogue; none in local-only mode), and the notification names the one that answered. Until one does, the work stays in Completed.

**Off.** With learning off (`skillLearning.enabled: false`), work past the window moves to Trash without any model call, a batch threshold or a notice.

An empty result is fine. A skill edited or deleted meanwhile, a reopened or pinned record, or an active job keeps the work for a later pass. The notice state is the per-space `hub.retention-mining` preference. Trash purge then follows its own retention window ([07 §1.1](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#11-completed-and-deleted-data-retention)).

The daily pass runs for each account on its own, so one waiting model never holds up anyone else's.

Learned changes are published directly after the notice; there is no review/accept step. There is no bulk mining of history at first run, no mailbox mining and no automatic creation of scheduled workflows.

## 5. Assistant management

| Request | Tool |
| --- | --- |
| Find current or disabled skills | `hub_list_skills` |
| Read a body in chunks, with retained version metadata | `hub_read_skill` |
| Create, update (body/name/description/enabled), restore a version or delete | `hub_manage_skill` |

`hub_manage_skill` waits for Apply and uses the skill routes; updates pass `expectedVersion` from `hub_read_skill`, and creation takes the initial body. These tools never start a preview or mining pass.

## 7. Privacy and tests

Skills are space-scoped and follow module and sharing access. Bodies can hold private instructions and learned guidance from the person's work; they are not anonymized. Export follows other space data. Deletion through `/api/skills/:id` is permanent; it does not put the skill in Trash.

Tests (under `apps/hub-api/src`): `jobs/retention.integration.test.ts` (mining with a fixture model), `test/resources.integration.test.ts` and `test/testing-report.integration.test.ts` (skill routes), `assistant/workspace-actions.integration.test.ts` (skill tools). They use fixture models, so they cover versioning and retention, not the quality of a live model's output.

## In the code

The code is in `apps/hub-api`: `routes/skills.ts`, `jobs/skill-mining.ts` and `assistant/tools/skills.ts`; Ensemble Node's catalogue is `node/skills.ts`. `apps/skill-forge` is an empty Python package stub; there are no `forge:*` or `ensemble-forge` commands. Skills are the `skills` module. Bundled skills are the root `skills/` folder, embedded by `packages/prompts` (§2.1).

`Skill` holds the current body, name, slug, description, scope, enabled/deleted state and version; `SkillVersion` holds past bodies. Bodies live in the database, not in files. The API returns the newest **three** versions, current included (`KEEP_VERSIONS`), and a body edit deletes older ones.

The Skills page is `apps/hub-web/app/(hub)/skills`. Morning brief defaults come from `cowork/morning-skill.ts` through `routines/service.ts` at signup; the saved body is `AssistantRoutine.instruction`.

### 6. API

| Method | Route | Behaviour |
| --- | --- | --- |
| GET | `/api/skills`, `/api/skills/:id` | Current records with up to three retained versions |
| POST | `/api/skills` | Create, optionally with an initial body |
| PATCH | `/api/skills/:id` | Edit name/description/body/enabled; optional `expectedVersion` |
| POST | `/api/skills/:id/restore` | Publish a retained version as a new version |
| POST | `/api/skills/:id/test` | Sample output from the Easy model; no tools, no external actions; needs a verified account; normal usage applies |
| POST | `/api/skills/:id/score` | Check a `draft` against the skill's rule lines |
| DELETE | `/api/skills/:id` | Permanently delete the skill, retained versions and feedback |

`/score` reads bullet lines in the body of the form `- must-include: …`, `- must-not-include: …`, `- max-words: N` and `- min-words: N`, and reports pass/fail for each. It is a literal text check, not a quality judgement.
