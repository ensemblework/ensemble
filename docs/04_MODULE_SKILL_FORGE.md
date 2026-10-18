# 04 · Personal skills and learning

Personal skills are editable, versioned Markdown instructions stored in the current Ensemble space. They help an assistant or assigned agent follow the person's preferences. They are not implementations of app actions: typed tools and built-in assistant playbooks perform that role ([11](11_HOW_THE_ASSISTANT_WORKS.md)).

**Status:** code inspected 18 Oct 2026. The working skill library, routing and completed-work miner live in `apps/hub-api`; `apps/skill-forge` is a package stub. There are no working `forge:mine`, `forge:bootstrap`, `forge:declare` or `ensemble-forge` commands in this repository.

## 1. Storage and editing

`Skill` holds the current body, name, scope, enabled/deleted state, version and learning metadata. `SkillVersion` retains **three versions total**, including current. Bodies live in the database, not a generated `skills/<id>/` directory or OneDrive.

The Skills page (`apps/hub-web/app/(hub)/skills`) edits the body with a 900 ms autosave delay. Restoration creates a new current version; it does not rewind the version counter. Deleted skills enter Trash. Disabled or deleted skills are omitted from active routing even if an older task references them.

`routes/skills.ts` and the shared version guard serialize updates. Optional `expectedVersion` rejects an edit based on an outdated body. The current Markdown body remains authoritative if older extracted style metadata disagrees with a hand edit.

## 2. Using skills

Tasks can explicitly link `skillIds`. Shared retrieval ranks applicable skills and puts selected instructions into the execution context; explicit selection does not override disabling a skill. A run records skill IDs and, for new runs, signatures containing ID, version and body SHA-256. Pruning an old body does not change the historical signature.

The Hub assistant initially receives a compact skill index. It can read the relevant body with `hub_read_skill` rather than adding every skill to every prompt. The Context Bridge returns current bodies only; it does not expose version history as current instructions.

A saved skill is reference guidance, not a permission grant, a credential or a scheduled program. Per-tool authorization and execution rules still apply.

## 3. Morning brief skill

`cowork/morning-skill.ts` creates the `morning-brief` personal skill using profession defaults. `/morning-brief` edits the person's instructions; normal versioning applies. The first delivered brief offers personalization once per account. Dismissal, saving and later deliveries do not reset that introduction.

Scheduled delivery begins on the local day after account creation and is idempotent per local day. A local/desktop runtime must be running for local delivery. Preview uses current Today context and the saved skill; it does not send messages or take calendar actions.

## 4. Completed-work learning

The implemented miner is `jobs/skill-mining.ts`, invoked by daily retention:

1. Select eligible, unpinned completed tasks and deliverables, at most 50 of each per batch.
2. Give at least **24 hours' notice** before learning and moving the work to Trash.
3. Call the person's **High** model with bounded completed-work evidence and current skill bodies.
4. Validate structured results. Create/version reusable guidance, preserving existing instructions when appending additions. The miner never changes `morning-brief`.
5. Write completion summaries and move the eligible batch to Trash atomically with the successful changes.

An empty learning result is allowed. A failed/offline model, concurrent skill edit, reopened/pinned record or active job preserves the original work for a later pass. The notice state is the per-space `hub.retention-mining` preference. Trash purge then follows its separate retention window ([07](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#11-completed-and-deleted-data-retention)).

**Current behavior:** validated retention learning publishes versions directly after notice. The proposed review/accept workflow is [not built](design/real-world-next.md#skill-mining). There is no first-run bulk historical mining, nightly mailbox mining, automatic procedural-skill discovery or scheduled workflow creation.

## 5. Assistant management

| Request | Tool |
| --- | --- |
| Find current or disabled skills | `hub_list_skills` |
| Read body in chunks and retained version metadata | `hub_read_skill` |
| Create, edit, enable, disable, restore a version or move to Trash | `hub_manage_skill` |

Management waits for Apply and uses the existing skill routes. Reads are bounded; updates use `expectedVersion`. Creation accepts the initial body in one action. These tools do not trigger a model preview or mining pass.

## 6. API

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/api/skills`, `/api/skills/:id` | Current records and up to three retained versions |
| POST | `/api/skills` | Create, optionally with an initial body |
| PATCH | `/api/skills/:id` | Edit metadata/body/enabled state; optional version precondition |
| POST | `/api/skills/:id/restore` | Publish a retained version as a new version |
| POST | `/api/skills/:id/test` | Generate a model preview without external actions |
| POST | `/api/skills/:id/score` | Check a supplied draft against supported machine-checkable rules |
| DELETE | `/api/skills/:id` | Move to Trash |

`/score` supports the implemented regex, section and word-count checks; it is not a semantic judge or a measured similarity score. Model preview requires an available model and consumes its normal usage.

## 7. Verification and privacy

Skills are space-scoped and subject to module/sharing access. Do not assume skill bodies are anonymized or safe to publish: the person may put private instructions in them, and learned guidance comes from their work. Account export/deletion and Trash apply through the normal data controls.

Focused regressions live alongside `routes/skills.ts`, `jobs/skill-mining.ts`, the assistant tools and shared retrieval. Mocked tests establish version/retention behavior; they do not establish a live model's style quality. No held-out skill corpus, numerical acceptance baseline or LLM similarity evaluation is claimed by this guide.
