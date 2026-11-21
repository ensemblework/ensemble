# @ensemble/prompts

The instructions Ensemble gives its models, as Markdown sections, and `assemble()`, which puts the
sections a request needs together in three tiers with a budget for each. The Hub assistant and Ensemble
Node use them today (`apps/hub-api/src/assistant/state.ts`, `apps/hub-api/src/node/instructions.ts`,
docs/11 and docs/35 §5.5).

## Layout

| Folder | What is there | Used by |
| --- | --- | --- |
| `sections/constitution/` | The shared rules: who Ensemble works for, whose word decides, how a task runs, acting, asking, permissions, tools, teamwork, knowledge, how replies read, and what counts as done | Every node turn gets all of them. The Hub assistant gets the ones whose note says "shared word for word" (`03-acting`, `09-look-up`, `10-sources`, `12-records`, `13-every-part`) |
| `sections/node/` | A node's role and charter, the routing rows (who does the work), crew, lead and step rules, helpers, sessions, the variants for the owner's own AI plan, the context tier (`50` to `57`, `67`), the turn packet (`80` to `83`) and the rules a plan step's task packet gives a coding agent (`84-task-report`, `85-task-review` for a review step) | `node/instructions.ts` (`nodeSections` chooses them from the turn's facts), `node/plans.ts` (`21-step-rules`, `85-task-review`), `node/packet.ts` (`84`, `85`; their version is the packet header's `instructionVersion`) |
| `sections/assistant/` | The Hub assistant's own lines: where it works, its scope, facts, dates, one space, playbooks and skills | `assistant/state.ts` (`assistantInstructions`) |
| `sections/code/` | The Code tab's own sections: none yet (the `code` surface may use this folder and the constitution) | Nothing |

`src/sections.generated.ts` holds every section's text, its variables and the SHA-256 of its text.
It is written by `scripts/generate.mjs` and committed, so nothing reads a Markdown file at run time: the
API, the desktop sidecar and the CLI's bundle import the module.

## Writing a section

- A file is `sections/<folder>/NN-name.md`: two digits, then lower-case words joined by hyphens. The
  number orders the folder; a variant of a section shares its number (`10-facts.md`,
  `10-facts-own-web.md`), and the code chooses one by its condition. Wording is never patched with
  string replacement.
- The text is sent as written, after notes for people (`<!-- ... -->`) and outer blank lines are
  removed. Keep each file to rules or data; say why a rule is there in its note.
- `{{name}}` is a variable the caller fills. A list renders one item per line. A section whose list
  is empty, or whose text renders empty, is left out.
- Write rules as what to do, in Ensemble's own words. No Markdown headings (models copied a heading
  into their replies), and no em dash, en dash or double hyphen: the generator refuses them.

After editing a section, run `pnpm prompts:build` (`pnpm --filter @ensemble/prompts build:sections`)
and commit the generated module with it. `pnpm prompts:check` and the package's tests fail while it
is out of date; CI runs both.

## Assembling

```ts
import { assemble } from "@ensemble/prompts";

const result = assemble({
  surface: "node",
  sections: [
    { name: "constitution/03-acting", tier: "stable" },
    { name: "node/57-memories", tier: "context", priority: 4, vars: { memories }, trim: "memories" },
  ],
  vars: { owner: "Mira" },
  budgets: { stable: 6000, context: 3000 },
});
```

- **Tiers.** `stable` (the constitution, the role, what it can do) is the same byte for byte while a
  node and its setup are the same. `context` changes between turns: the room and who is in it, crew
  and rooms, labelled as information, not instructions; then, each under its own label, the skills for
  this request (guidance) and the owner's standing preferences (what they told the node to remember).
  `volatile` is the turn packet.
- **Budgets** are tokens per tier, estimated as characters / 4. Each tier is filled in priority order
  (lower first, then the order given). A section that does not fit is left out whole, or loses the
  last items of its `trim` list, never part of a sentence; either way it is listed in `dropped`.
- **Result.** `text` (the tiers in order), `tiers` (each tier's text), `version` (a hash of the
  section files used and their SHA-256: which instructions, at which revision), `hash` and `hashes`
  (of the text and of each tier), `sections` (`name`, `tier`, `chars`, `tokens` for each section used)
  and `dropped`.
- A surface may use its own folder and the constitution; a section from another surface's folder is
  refused, and so is a variable left out.

`renderSection(name, vars)` fills one section; `sectionText(name)` is its text unfilled.

## Where the tiers go

On Ensemble's own model loop a node turn's system message is the stable and context tiers, and the
user message is the turn packet. On the owner's own AI plan (Claude Code, Codex, Copilot and the
rest) the system prompt is the stable tier alone, so the agent's session keeps the instructions it
began with, and the context tier leads the turn's prompt. Each node turn records `version`, the
hashes, the sections and what was dropped once, as its `node.instructions` metric; each of its
`model.call` metrics names only the version and hashes (docs/35 §5.5).

## Checks

```sh
pnpm --filter @ensemble/prompts test        # assemble, budgets, the generated module up to date
pnpm --filter @ensemble/prompts typecheck
```
