# 04 · Module M3 — Skill Forge (personal skills mined from my history)

**Purpose:** Turn how I actually work — my PR descriptions per repo, my commit messages, how I reply to email and Teams, the libraries and patterns I reach for — into **versioned, inspectable personal skills** the agent loads automatically. This is what makes agent output land in *"approve"* instead of *"rewrite"*.

---

## 1. What a skill is

A folder in `skills/<skill-id>/` in the **SKILL.md convention** (same shape as Copilot/agent skills, so it is readable by a human, diff-able in git, and loadable by any agent runtime):

```text
skills/pr-description.service-x/
├── SKILL.md          # front-matter + instructions + few-shot examples
├── examples/         # 3–6 exemplar artifacts (redacted) used as few-shots
├── evidence.json     # artifact ids this was mined from + stats
└── tests/            # golden inputs → expected properties (not exact text)
```

**Skill kinds for v1:**

| Skill id pattern | Mined from | Used by worker |
|---|---|---|
| `pr-description.<repo>` | my merged PRs in repo + my edits/rejections | `pr_author` |
| `commit-message.<repo\|default>` | my commits (conventional-commits? scopes? length) | `pr_author` *(inferred)* |
| `code-review.<repo>` | my review comments (what I flag, tone, severity words) | `pr_reviewer` (P1) |
| `email-reply.<default\|person>` | my sent mail (greeting, length, sign-off, formality per recipient) | `email_reply` *(inferred)* |
| `teams-reply.<default\|chat>` | my sent Teams messages (brevity, emoji use, @-mention habits) | `teams_reply` *(inferred)* |
| `coding-prefs.<language>` | my repos (libs, test framework, lint config, patterns) | workspace help |
| `docs.adr` / `docs.status-update` | my past ADRs / weekly updates in SharePoint/OneDrive | `doc_author` |
| `meeting-notes.default` | how I structure notes I've sent after meetings | `meeting_actions` |
| `day-planning.default` | calendar habits (focus blocks, meeting-free hours) | `day_planner` |

### Example `SKILL.md`

```markdown
---
id: pr-description.service-x
name: PR description style — service-x
version: 3
scope: { repo: "ensemble-demo/service-x", taskTypes: ["open_pr", "update_pr"] }
confidence: 0.86
minedFrom: 27 PRs (2025-11 → 2026-09), 4 user edits
lastAcceptedRate: 0.78
---

## When to use
Drafting or revising a pull request title/body for `service-x`.

## Style rules (observed)
- Title: "<area>: <imperative summary>", ≤ 70 chars, area ∈ {ranker, api, infra, tests}.
  Example: "ranker: bump retry lib to 2.4 and cap backoff".
- Body sections in this order: **Why**, **What changed**, **Testing**, **Risk / rollback**, optional **Follow-ups**.
- Always link the work item as "AB#<id>" on the first line of Why.
- Testing lists concrete commands run (`make test-ranker`) and perf numbers when latency-related.
- Tone: terse, bullets, no emojis. Mention reviewers to ping only when touching /ranker/cache/* (Rahul).

## Anti-patterns (from rejected drafts)
- Don't paraphrase the diff line by line. Don't add "This PR…" openers.

## Examples
(see examples/ — 3 full PR bodies)
```

---

## 2. Mining pipeline (offline, re-runnable)

```text
collect → redact → cluster → extract style (LLM) → synthesize SKILL.md → self-test + version → publish
```

1. **Collect** (`miners/<kind>.py`): pull my authored artifacts from the Context Engine (already normalized: e.g. `Artifact.kind = 'pr' AND actor = me AND repo = …`, sent mail (from = me), Teams messages (from = me)).
2. **Redact:** strip secrets, customer names (regex + LLM pass); skills only need *shape*.
3. **Cluster** when a kind has natural sub-scopes (per repo, per recipient/group). **Minimum support: 8 artifacts** for a scoped skill, else fall back to default.
4. **Extract style** (`gpt-4.1`, structured output) — prompt asks for *observable, checkable* rules: structure, length distribution, vocabulary, greeting/sign-off, formatting, linking habits, what is always/never present, tone descriptors, notable exceptions. Output JSON `StyleProfile`.
5. **Synthesize** `SKILL.md` from `StyleProfile` + 3–6 exemplar artifacts (shortest diverse set) using a template.
6. **Self-test:** generate a draft for 3 held-out inputs with the skill; an LLM judge scores rule adherence + similarity to the real artifact (structure & tone, not text). Publish only if score ≥ threshold; otherwise flag "low confidence".
7. **Version:** atomically advance the current database version and retain the two preceding bodies. Together with current, this is **three versions total**: after v7, v5/v6/v7 remain. API edits, accepted proposals, assistant edits, Forge publication and undo share the database guard; undo creates a new version rather than rewinding the counter. A proposal does not advance the published version until accepted.

**Schedule:** full mine on first run (`ensemble-forge mine --all`), then nightly incremental refresh using new artifacts + new feedback.

---

## 3. Learning from feedback (the loop that makes it personal)

Signals captured by the Hub (see [02 §4](02_MODULE_INTERACTION_HUB_UI.md#4-interaction-patterns-details-worth-getting-right)) into `skills.evidence`:

- **`edited_before_approve`** — diff between agent draft and user's edited version → miner extracts rules implied by edits (*"user always removes 'Hope you're well'"*).
- **`rejected`** with reason (free text).
- **`accepted_as_is`** — reinforces current rules.
- **Context corrections** (e.g. *"Rahul is not on ranker anymore"*).

**Nightly:** `miners/feedback.py` folds these into the `StyleProfile` (rules gain/lose weight), regenerates `SKILL.md` as a **proposed version**; the user sees *"Skill email-reply.default v4 proposed — 3 changes"* in the Skills page with a diff → **Accept / Reject**. **Skills never change silently.**

`GET /api/skills/:id/history` is **authenticated human UI history only**; it is not an assistant, worker, retrieval or MCP tool. Ordinary reads use the current `skills.body`, never `skill_versions`. Legacy correction feedback bodies are reduced to signatures before mining so retired instructions do not become future model input. History is pruned on every publication and by daily cleanup, including pre-existing histories; this count limit is independent of the 15/30/45/60-day deletion policy.

The Skills editor **autosaves body edits after a 900 ms pause**, serializing snapshots so a slow response never replaces newer typing. Merely opening a skill does not write a version. Saves compare the last acknowledged version while holding the skill row lock; conflicts and network failures keep the local draft visible with retry/reload controls. Switching skills flushes the current draft. Regenerate, proposal decisions and draft tests remain explicit clicks, not side effects of autosave.

---

## 4. Skill Router (runtime)

```python
def route(intent: Intent, ctx: ContextPack) -> list[Skill]:
    candidates = registry.match(
        task_type=intent.type,
        repo=ctx.repo,
        person=ctx.primary_person,
        channel=ctx.channel,
        language=ctx.language,
    )
    # specificity order: person/repo-scoped > default; ties → higher confidence & acceptance rate
    return top_n(candidates, n=3, max_tokens=2500)
```

The router's choice is recorded in `Run.skillIds`. New runs also freeze `Run.skillSignatures` (id, exact version, SHA-256 of the body); pruning a historical body does not rewrite that audit signature. Legacy runs with no signature are not relabelled with today's version.

**Loading:** the worker prompt = identity block + task + context pack + `SKILL.md` bodies (examples included only if token budget allows). The **current body is authoritative** even if a hand edit leaves the mined `styleProfile` out of date. Job payloads, the workspace reader, the shared retrieval tools and the Context Bridge read current rows only; the Python registry also excludes soft-deleted skills. Already-authorized continuation snapshots remain private execution/audit state, not history retrieval endpoints.

**Task-level selection:** a task page can link explicit `skillIds`. These are validated as the user's own skills, ranked ahead of automatically suggested ones by the shared router, and included in the job/context pack. A disabled skill remains disabled even if an older task still references it.

---

## 5. Auto-discovering new skills (P2, but design it now)

Detect repeated behaviours that are not yet skills:

- **Repeated task shapes** in the ledger (e.g. every Friday I send a status mail to Shachee with the same sections) → propose `docs.status-update.weekly` with a scheduled job attached.
- **Repeated manual sequences** in the workspace (branch → edit `version.yaml` → run `make bump` → PR) → propose a procedural skill with a `scripts/` step list.
- **Repeated corrections** of the same kind across skills → propose a global preference.

Proposals appear as cards: *"I noticed you did X 4 times. Make it a skill?"*

---

## 6. Evaluation

`eval/skills/` holds, per skill, **≥ 5 held-out real artifacts**. Metrics:

- **Rule adherence** (checkable rules → regex/structure checks, e.g. has "Why" section, title ≤ 70 chars).
- **Judge similarity** (0–1) vs. the real artifact.
- **Live acceptance rate** = `accepted_as_is / (accepted + edited + rejected)` from the ledger — this is the headline before/after number (*"generic prompt 31% → personal skill 78%"*).

---

## 7. Safety & privacy

- Skills contain style rules and redacted exemplars only, never credentials or customer data. Redaction test in CI.
- Skills are per-user, stored in the user's repo/OneDrive folder; not shared unless the user exports them.
- A skill can be disabled instantly from the UI; disabled skills are excluded by the router.

---

## 8. Dev checklist

> Unchecked means not re-verified against this tree. [18](18_WHAT_IS_REAL.md) records what is.

- [ ] `ensemble_forge/miners/{pr_style, commit_style, email_tone, teams_tone, code_prefs}.py`
- [ ] `StyleProfile` pydantic model + extraction prompt (`packages/prompts/forge/extract_style.md`)
- [ ] `SKILL.md` synthesizer template + `evidence.json`
- [ ] Self-test judge + threshold config
- [ ] `skills/registry.py` (load, index by scope, version) + `router.py`
- [ ] Feedback folding (`miners/feedback.py`) + "proposed version" flow
- [ ] Hub Skills page hooks (`GET/PUT /api/skills`, `/regenerate`, `/test`)
- [ ] Seed: ship 4+ skills before the demo

---

## 9. Cold start — how a skill works before there is any history

The mining design above assumes 8–27 authored artifacts per skill. On a real first run there are none, so the Forge is built around a **visible confidence ladder** rather than an all-or-nothing mine:

| Rung | Confidence | What it means |
|---|---|---|
| `bootstrap` | ≤ 0.45 | Hand-written sensible defaults. Nothing has been learned about you yet, and the `SKILL.md` says so in the body. |
| `provisional` | 0.45 – 0.69 | Learned from a thin sample (≥ 2 artifacts) or from your feedback. Real but not yet trustworthy. |
| `mined` | ≥ 0.70 | Backed by ≥ 8 of your own artifacts. |
| `declared` | ≥ 0.80 | You stated it. Not inferred at all. |

**`declared` sits outside the ladder** rather than at the top of it. The other three are degrees of evidence about what you *did*; a declared skill is what you *said you want*, which is different information and better information — someone who asks for plain English is describing the mail they meant to send, not the mail they sent at 23:00 under deadline.

Consequences:

- its rules are **pinned**, so folding feedback can add to them and reorder them but never erode them;
- it **outranks mined** in the router (`provenance_bonus` 1.5 vs 1.0), so an observed habit cannot quietly override a stated preference;
- it is installed by `pnpm forge:declare`, separately from `forge:bootstrap`, because it is not a guess to be outgrown. `declared.py` is the catalogue of what Ensemble *can* declare, not what any one engineer has asked for, so `forge:declare` takes `--only`:

```bash
ensemble-forge declare --only email-writing.declared --only teams-reply.declared
```

Installing the whole catalogue on a hub that wanted two of them buries the two, and a skill the engineer never asked for still outranks a mined one in the router — which is the same failure as fabricating a preference.

**A skill is never fabricated at high confidence** — presenting a default as an observation is the fastest way to lose trust the first time the engineer notices.

Three things make cold start work:

1. **Bootstrap skills ship immediately** (`pnpm forge:bootstrap`): five profiles with checkable rules and real few-shot examples. During cold start the few-shots do most of the work — two concrete samples beat a page of inferred rules.
2. **Thin history is still mined.** One artifact is an anecdote and is ignored; two or more produce a provisional skill, and the engineer's real artifacts immediately replace the invented exemplars.
3. **Every decision teaches.** Approve, edit or reject in the Hub and the signal is written to `skill_feedback` against the skills that shaped the draft. `ensemble-forge fold` turns those into rules:
   - an edit that deletes filler → an anti-pattern (*"Hope you're well"*),
   - a consistently shortened draft → a measured length rule,
   - a rejection reason → an anti-pattern,
   - an explicit instruction → a pinned rule that never decays.

The first edit alone promotes a skill from bootstrap to provisional.

**Verified end to end:** editing an approval in the Hub produced a `skill_feedback` row; folding it learned *"prefers about 16 words"* plus the phrasing the engineer substituted, and raised a proposed v2 for review while the live version stayed untouched — skills never change silently (§3).

### Notes from the earlier prototype

These notes describe how an earlier prototype met the checklist. Most of the files they name are not in this tree; [17](17_REPOSITORY_STRUCTURE.md) and [18](18_WHAT_IS_REAL.md) describe what is.

| Component | Where |
|---|---|
| `StyleProfile`, confidence ladder | `apps/skill-forge/ensemble_forge/style.py` |
| Declared skills (`pnpm forge:declare`) | `apps/skill-forge/ensemble_forge/declared.py` |
| Bootstrap profiles | `ensemble_forge/bootstrap.py` |
| Miners | `ensemble_forge/miners/extract.py` |
| Feedback folding | `ensemble_forge/miners/feedback.py` |
| `SKILL.md` synth + judge | `ensemble_forge/synth/__init__.py` |
| Registry + router | `ensemble_forge/registry.py` |
| Hub API | `apps/hub-api/src/routes/skills.ts` |

**Commands:** `pnpm forge:bootstrap`, `pnpm forge:mine`, `pnpm forge:fold`, `pnpm forge:list`, and `ensemble-forge test <slug> --file draft.md`.

**Judge scope.** Only rules with a machine-checkable form (`regex:`, `sections:`, `maxwords:`) are scored; a rule the judge cannot verify must not be allowed to inflate the score. The Hub re-implements the same three checks in TypeScript so `/api/skills/:id/test` needs no round trip to Python — note that rules are authored with Python's inline `(?i)` flag, which JavaScript rejects, so the Hub translates it rather than silently skipping the rule.

**Deferred.** The LLM style-extraction pass (§2 step 4) and the LLM-judge similarity score (§2 step 6) need a model credential; the structured miners and the rule-adherence judge cover both today and the prompt is written and ready at `packages/prompts/forge/extract_style.md`.

---

## 10. Hub "Improve skills from my work" run

The Skills page has an explicit **Improve skills** action for the slow, max-reasoning learning pass. It creates a durable `Run` with worker `skill_improver`, resolves and validates the configured **max** complexity model profile (model and reasoning effort), freezes it in the checkpoint, registers a cancellable activity, and checkpoints progress in `Run.checkpoint`. If the server stops while a billable model request is marked in flight, the restarted worker fails that run with a *"not retried automatically"* message instead of silently spending another call.

The model is given **read-only catalogue tools** under `apps/hub-api/src/skills/`: completed tasks and transitions, runs and steps, workspace job evidence, people/projects/repos/deliverables/preferences/meeting notes/artifacts/documents, and bounded keyword search. These tools use ordinary `app.prisma` reads, so the soft-delete extension excludes deleted rows; no raw SQL is used. URL fetching is off by default and no arbitrary web fetch tool is exposed.

Proposals follow the existing contract: **the live `Skill.body` is never changed**. Accepted evidence-backed updates are stored in `Skill.proposedBody`, `proposedChanges`, and `proposedAt` for review in the Skills page. Every example is re-read from its cited source id (`artifact:<id>`, `task:<id>`, `workspace-job:<id>:prBody`, etc.) and **kept only when the excerpt is a verbatim substring of that source**. Unsupported or uncited proposals are discarded.
