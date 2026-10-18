# 33. Included AI and Ensemble credits

A hosted operator can offer the supported configured Azure AI Foundry deployments and pay for their calls. Every
verified account then gets **20,000 Ensemble credits a month** to spend on them, with no key of its
own. People see credits only, never dollars. Once the operator's monthly ceiling is reached, every
included call stops for everyone until the 1st, even for accounts that still have credits.

Implementation reviewed 18 Oct 2026 in `apps/hub-api/src/included/` and both model runtimes. Focused unit/HTTP tests cover metering and transport contracts with fixtures. This documentation audit does not verify live Azure quota, current deployments or portal billing. Availability depends on the configured Azure variables (§8).

## 1. The models

Provider id `ensemble`, shown as **Included with Ensemble** (`packages/shared-types/src/included.ts`).
Each model ID maps to the configured Azure deployment name and transport below. This table describes the checked-in catalog (`packages/shared-types/src/included.ts`), not a live Azure availability, quota or marketplace-entitlement check. Operators must verify their actual resource/deployments; private setup notes record the deployment-specific details.

| Model | Shown as | API on Azure | Thinking | Typical cost |
|---|---|---|---|---|
| `gpt-6-luna` | GPT-6 Luna (2026-09-22) | Responses, `https://{resource}.openai.azure.com/openai/v1/responses` | Auto (Medium), Low, Medium, High | 1× |
| `deepseek-v4-flash` | DeepSeek V4 Flash | Chat Completions, `https://{resource}.services.ai.azure.com/openai/v1/chat/completions` | Auto only | about 2× |
| `gpt-6.1-sol` | GPT-6.1 Sol (2026-09-29) | Responses, `openai.azure.com` | Auto (Medium), Low, Medium, High | about 20× |
| `grok-4.7` | Grok 4.7 | Responses, `https://{resource}.services.ai.azure.com/openai/v1/responses` | Auto (High), Low, Medium, High | about 20× |

**Additional supported deployments:** the following appear only when enabled in `ENSEMBLE_INCLUDED_MODELS`. Offering them does not establish an Azure free-tier entitlement or token-per-minute quota.

| Model | Shown as | API on Azure | Thinking | Typical cost |
|---|---|---|---|---|
| `gpt-5-mini` | GPT-5 mini (2025-08-07) | Responses, `openai.azure.com` | Auto (Medium), Low, Medium, High | about 3× |
| `gpt-4.1-mini` | GPT-4.1 mini (2025-04-14) | Responses, `openai.azure.com` | Auto only (no reasoning) | about 4× |

"Typical cost" is a turn of 25,000 input and 1,000 output tokens next to GPT-6 Luna. The GPT models
always use the Responses API (`store: false`): GPT-6.1 Sol takes function tools only there. Both
runtimes send the key in the `api-key` header, no temperature or `top_p`, and no fallback model.

**Thinking levels** are Auto, Low, Medium and High (`modelEfforts("ensemble", …)` in
`model-efforts.ts`); Extra high and Max are not offered and are refused if sent. Auto sends no level,
so the model uses its own default. The level goes in `reasoning.effort`. The checked-in catalog defines no
thinking setting for DeepSeek V4 Flash, so it offers Auto only and never receives a level.

**Context** follows the configured model/transport; there is no user-selectable context-size tier. Existing caller/tool-result bounds still apply. Each call carries a **reply cap**,
`ENSEMBLE_INCLUDED_MAX_OUTPUT_TOKENS` (default 16,000; `max_output_tokens`, or `max_completion_tokens`
on Chat Completions). Reasoning tokens count against it, it bounds what a call can cost before it runs
(§3), and Azure counts it against the deployment's tokens-per-minute quota when the request starts.

The transports also speak Foundry's Anthropic Messages endpoint (`api: "anthropic"`), with the Claude
thinking-block handling in §4, for an operator who adds a Claude deployment billed to a card. No model
in the catalog uses it today.

## 2. Credits

- 1,000 credits = $1 of model cost at the provider's list price. The conversion is internal
  (`CREDITS_PER_USD` in `apps/hub-api/src/included/config.ts`); the dollar ledger never leaves hub-api.
- Credits belong to the **account**: a space spends its owner's credits, and in a space shared with you
  the call is yours, as with model keys ([28](28_ENSEMBLE_SPACES.md), [29](29_SHARING.md)).
- The month is the **UTC calendar month**; credits reset at 00:00 UTC on the 1st. Unused credits do not
  carry over.
- Background work that runs on an included tier (document summaries, skill mining, the model test)
  spends the same credits as the chat.
- How a call's cost splits between input and output does not matter to the allowance; the Metrics page
  shows the split anyway (§6).

## 3. How a call is metered

`apps/hub-api/src/included/budget.ts`, tables `included_usage` and `included_periods`
(migration `20261017180000_included_credits`).

1. **Reserve.** Before calling Azure, the runtime asks hub-api to reserve the most the call could cost:
   every input token uncached plus the full reply cap, at the model's rates. Input is counted as the
   request body's size in UTF-8 bytes: the models' byte-level tokenizers never make more tokens than
   bytes, so the reservation is an upper bound (about four times the real count for English). hub-api takes the month's row lock and refuses when
   - the operator's spend plus open reservations plus this call would pass
     `ENSEMBLE_INCLUDED_TOTAL_MONTHLY_USD` → `included_paused` (429), or
   - the account's spend plus open reservations plus this call would pass its credits →
     `included_credits_used` (429), with how many credits the call could need and how many are left.
   A refused call holds nothing and never reaches Azure. The Python runtime reaches hub-api through
   `POST /api/internal/included/reserve`; the in-process runtime calls the same function. If hub-api
   cannot be asked, Azure is not called either: "Ensemble could not check your credits just now. Try
   again in a moment." (`included_unavailable`).
2. **Call** Azure once (retries of a transient error stay inside the same reservation).
3. **Settle** with what Azure reported: all input tokens, the part read from the prompt cache, the part
   written to it, and output tokens (`POST /api/internal/included/settle`). The cost uses
   `apps/hub-api/src/included/pricing.ts`: cache reads and writes at their own rates, and the
   long-prompt rates for the whole request when its input passes 272,000 tokens (GPT-6) or reaches
   200,000 (Grok 4.7). A request Azure refused, or that never reached Azure, settles at zero. A request
   that stops without the provider saying what it used (the person pressed Stop, a timeout, a dropped
   connection) is charged its reservation, because Azure may have billed it. Settling twice keeps the
   first. If the settle call itself fails, the reply still arrives and the reservation expires (step 4).
4. A reservation nobody settles within 30 minutes (a crashed runtime) is **expired** at its reserved
   amount by the next reservation.

So neither limit can be overrun by calls in flight, and the operator's ceiling is checked against real
token counts, not Azure's billing data (which arrives 8–24 hours late). The per-call cost and its
credits are also recorded on the `model.call` metric (`credits`, with `estimatedUsd` null) and on run
steps.

Before a chat opens its stream, `POST /api/assistant/turn` makes the cheap version of the same check
(`assertIncludedOpen`) so a person with no credits gets the message at once.

## 4. Where included models run

- The hosted assistant (chat, Ask, page and comment answers) and `complete()` callers on the server.
  In hosted production that is the Python runtime (`ensemble_agent/included.py`); the desktop sidecar
  has a TypeScript copy (`apps/hub-api/src/runtime/included.ts`) used in development and tests.
- **The desktop app and the CLI, on a computer connected to an account** (paired: Settings → Account →
  This computer in the app, `ensemble login` with *Run tasks* approved in the CLI; docs/25). They hold
  no Azure key and no ledger. Their local server (`apps/hub-api/src/included/device.ts`) reads the
  account's included models and credits from `GET /api/devices/self/included` (held for a minute) and
  sends each included call to `POST /api/devices/self/included/turn` with its device token. Ensemble's
  server runs it with `includedTurn` on that account's credits, under the same monthly ceiling as the
  web, and answers the turn or the refusal (§5). Chats, the assistant's model menu, Settings → Models,
  Metrics and the CLI's `/model` all list them there; a computer's tiers are its own and are not
  switched to included models by themselves (pick one in Settings → Models or the model menu).
- **Not on a local-only computer.** A desktop app or CLI that is not connected to an account lists the
  included models as unavailable (`code: "included_local_only"` on the `/api/models` row) and refuses
  every included call with `included_local_only` (§5): the app shows *Included models need your
  Ensemble account* with **Connect this computer**, and the CLI a framed notice pointing at `/login`.
- Server workspace jobs stay operator-only, as before ([06](06_MODULE_WORKSPACE_AND_SURFACES.md)).

For a Claude deployment (§1, not in the catalog today), a tool round sends back the exact content
Claude returned for that turn (kept in memory by tool-use id, up to 2,000 turns), thinking blocks
included. If Azure still refuses a request over thinking blocks, it is retried once with them removed
and thinking off for that request.

## 5. When a call cannot run

| Code | Status | When | What people read |
|---|---|---|---|
| `included_credits_used` | 429 | The account's credits for the month are used up, or this call could pass them | "You've used this month's Ensemble credits. They reset on Nov 1. To keep going now, add your own API key or AI plan in Settings → Models." (or how many credits the call could need and how many are left) |
| `included_paused` | 429 | The operator's monthly ceiling is reached | "Ensemble's included AI is paused for everyone until Nov 1: this month's shared budget is used up, even for accounts with credits left. Your own API keys and AI plans still work (Settings → Models)." |
| `included_unavailable` | 503 | Not set up on this server, switched off, a model the operator did not deploy, or hub-api could not be asked | "Included AI is not set up on this server…" |
| `included_local_only` | 403 | A desktop app or CLI that is not connected to an Ensemble account, or one whose computer was removed | "Included models need this computer connected to your Ensemble account: they run on Ensemble's server and use your account's credits. Connect it in Settings → Account → This computer, or use your own API key or AI plan (Settings → Models)." |

The body is `{code, error, message, resetsAt, status}` (`IncludedErrorBody`), as an HTTP response or as
the assistant stream's `error` frame. Like a provider quota, the sentence is shown in the chat but not
stored as something the assistant said.

## 6. What people see

- **Settings → Assistant → Models**: the provider picker has an **Included** tab (first, and remembered
  like the other two) when the server offers included models; its entry says how many credits are left,
  or "paused until Nov 1". Picking it sets the tier to the first everyday model with Auto thinking.
  Models show by name with their version and a cost badge relative to GPT-6 Luna (1×, 2× or 20×); a
  typed model name is not accepted. Thinking reads "Auto (Medium)" (the model's own default), Low,
  Medium and High; DeepSeek V4 Flash shows Auto only. A line under the API keys row shows the credits left this month and the reset date,
  with a link to Metrics; tiers say when credits are used up or included AI is paused
  (`components/settings/models.tsx`, `model-picker.tsx`, `lib/included.ts`).
- **Metrics**: an **Ensemble credits** card (`GET /api/metrics/credits`): credits left of the month's
  allowance, the reset date, whether the shared budget is paused, input and output credits with their
  token counts (and how many input tokens came from the prompt cache), credits by model, by purpose and
  by day (`components/metrics/included-credits.tsx`). In the call lists, the daily tooltip and the
  purposes, included calls show credits instead of a dollar estimate, and the provider filter lists
  *Included with Ensemble*.
- **When a call cannot run**, the chat and *Ask Ensemble* on a page show the server's sentence (§5) in
  their error banner. It is not stored as a message, does not mark the model "out of quota", and the
  credits and model list refresh.
- **The reply footer** names where an included answer came from as *Ensemble included*, with the
  model's name and version (replies saved earlier said "API key · ensemble" and read the same way now).
- Nothing about credits appears when the server offers no included models. A local-only desktop app or
  CLI shows the *Included models need your Ensemble account* notice instead, in Settings → Models, on
  Metrics and in the assistant's model menu (`IncludedLocalOnly` in `components/metrics/included-credits.tsx`).
- **The assistant's model menu** (the Low/Medium/High/Max button under the chat box) lists the included
  models under *Included with Ensemble*, with the credits left. Picking one sends that model with each
  message of the chat on Auto thinking (`model`, `provider: "ensemble"`, `reasoningEffort: "default"` on
  `POST /api/assistant/turn`); picking a tier goes back to the tier's model
  (`components/assistant/assistant-dock.tsx`).
- **Every hosted account gets included models where it has no other way to answer**
  (`apps/hub-api/src/included/defaults.ts`): a tier whose provider has no key the account can use (no key
  saved for that provider, and not an operator with that provider's server key) reads as an included
  model. That covers the shipped Gemini default for everyone without a Google key, and older accounts
  whose tiers name a provider they never added a key for. Low and Medium use the first everyday model
  (GPT-6 Luna; GPT-5 mini on a free account), High the first step-up model (GPT-6.1 Sol), Max the same
  at High thinking. A tier on the account's own key, its AI plan (Claude Code, Codex…) or Cursor is
  never changed. Saving settings keeps what was read.

## 7. API

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/metrics/credits` | Signed-in account (class `personal`: in a shared space, your own) | `IncludedUsage`: `available`, `models`, `period`, `resetsAt`, `limit`, `used`, `remaining`, `paused`, `totals`, `byModel`, `byPurpose`, `days`. Credits only |
| POST | `/api/internal/included/reserve` | agent-runtime, `x-ensemble-internal` + `x-ensemble-user` | `{model, inputTokens, maxOutputTokens, purpose?}` → `{id}`, or the 429/503 body above |
| POST | `/api/internal/included/settle` | agent-runtime | `{id, usage: {inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens} \| null, answeredBy?}` → `{credits}` |
| GET | `/api/devices/self/included` | A paired computer's device token only | `{catalog, usage}`: the `/api/models` row and `IncludedUsage` for the computer's account |
| POST | `/api/devices/self/included/turn` | A paired computer's device token only (rate bucket `model`, body up to 16 MB) | `{model, messages, items?, jsonMode?, reasoningEffort?, chatTools?, responsesTools?, purpose?}` → `{turn}` with `credits`, or the 403/429/503 body above. The account comes from the token, never the body |

`GET /api/models` lists the included models as one more provider (`source: "included"`, levels Low to
High in `meta`) when the server offers them; it carries no key and no price. In the desktop app and the
CLI the row comes from the account's server, or is unavailable with `code: "included_local_only"`.
`GET /api/metrics/credits` there answers the account's credits, or `available: false, localOnly: true`.

## 8. Operator settings

| Variable | Default | Meaning |
|---|---|---|
| `AZURE_FOUNDRY_RESOURCE` | (none) | The Foundry resource name, such as `ensemble-ai`, not a URL |
| `AZURE_FOUNDRY_API_KEY` | (none) | The resource's key. Server-only: never returned by `/api/credentials`, the catalog or any page |
| `ENSEMBLE_INCLUDED_MODELS` | the four in §1 | Comma list of the deployments to offer (the default catalog or the additional supported `gpt-5-mini` / `gpt-4.1-mini` deployments), or `off` (the kill switch). A wrong value (an id Ensemble does not include, a URL as the resource) turns included AI off and is logged by hub-api ("Included AI is off: …") |
| `ENSEMBLE_INCLUDED_MONTHLY_CREDITS` | 20000 | Credits per account per month |
| `ENSEMBLE_INCLUDED_TOTAL_MONTHLY_USD` | 180 | Model cost across every account per month, in USD |
| `ENSEMBLE_INCLUDED_MAX_OUTPUT_TOKENS` | 16000 | Reply cap per call, reasoning included (max 128000) |

hub-api and agent-runtime read the same values from `/etc/ensemble.env`. An Azure budget does not stop
spending (it only alerts, a day late); keep one anyway on the subscription that holds the Foundry
resource, as a second net. The deployment runbook lives with the other private runbooks, not in `docs/`.

## 9. Data and retention

`included_usage` keeps one row per included call: account, space, month, model, purpose, status,
token counts, and the dollar cost the credits come from. It holds no prompt or reply text. Rows are
kept, and deleted with the account. `included_periods` keeps each month's total across all accounts and
is not deleted with an account, so deleting an account does not hand its spend back to the ceiling
([07](07_MODULE_GOVERNANCE_AUDIT_METRICS.md)).

## 10. Honest limits

- Not yet run against live Azure deployments; request and usage shapes follow Microsoft's and
  Anthropic's documentation as of 17 Oct 2026 and are pinned by tests with recorded shapes.
- Prices are a table in code (`pricing.ts`). If Azure or Anthropic change a rate, the table must change
  with it or the ceiling is counted at the old rate.
- The reservation is an upper bound only if Azure stops each reply at the cap. Microsoft documents that
  the cap includes reasoning for GPT-6 and Grok 4.7; it does not say so for DeepSeek V4 Flash. A reply
  that ran past its cap would still be charged what Azure reported, and hub-api logs it ("settled above
  its reservation"), so an account or the ceiling could pass its limit by that much.
- The upper-bound input estimate makes reservations large: near the end of an allowance, a step-up
  model can be refused ("could use up to … credits") while an everyday model still runs.
- Included calls are not streamed token by token: the reply arrives whole and the chat shows it in
  pieces.
- Credits are monthly only; there is no paid top-up or plan with more credits yet.
