# 33. Included AI and Ensemble credits

On a hosted Ensemble the operator can run four models on Azure AI Foundry and pay for them. Every
verified account then gets **20,000 Ensemble credits a month** to spend on them, with no key of its
own. People see credits only, never dollars. Once the operator's monthly ceiling is reached, every
included call stops for everyone until the 1st, even for accounts that still have credits.

Built 17 Oct 2026. Checked with unit and integration tests (`apps/hub-api/src/included/*.test.ts`,
`apps/hub-api/src/runtime/included.test.ts`, `apps/agent-runtime/tests/test_included.py`) on 17 Oct
2026; **not yet checked against live Azure deployments**. Off until the operator sets the Azure
variables (§8).

## 1. The models

Provider id `ensemble`, shown as **Included with Ensemble** (`packages/shared-types/src/included.ts`).
Each model id is also the Azure deployment name. All four are **Global Standard** deployments of
Foundry Models *sold by Azure*: Microsoft bills them per token, with no hourly or fixed charge, and
Azure credits can pay for them. Claude is not offered, because Azure sells it through the Marketplace
and credits cannot pay for it.

| Model | Shown as | API on Azure | Thinking | Typical cost |
|---|---|---|---|---|
| `gpt-6-luna` | GPT-6 Luna (2026-09-22) | Responses, `https://{resource}.openai.azure.com/openai/v1/responses` | Auto (Medium), Low, Medium, High | 1× |
| `deepseek-v4-flash` | DeepSeek V4 Flash | Chat Completions, `https://{resource}.services.ai.azure.com/openai/v1/chat/completions` | Auto only | about 2× |
| `gpt-6.1-sol` | GPT-6.1 Sol (2026-09-29) | Responses, `openai.azure.com` | Auto (Medium), Low, Medium, High | about 20× |
| `grok-4.7` | Grok 4.7 | Responses, `https://{resource}.services.ai.azure.com/openai/v1/responses` | Auto (High), Low, Medium, High | about 20× |

"Typical cost" is a turn of 25,000 input and 1,000 output tokens next to GPT-6 Luna. The GPT models
always use the Responses API (`store: false`): GPT-6.1 Sol takes function tools only there. Both
runtimes send the key in the `api-key` header, no temperature or `top_p`, and no fallback model.

**Thinking levels** are Auto, Low, Medium and High (`modelEfforts("ensemble", …)` in
`model-efforts.ts`); Extra high and Max are not offered and are refused if sent. Auto sends no level,
so the model uses its own default. The level goes in `reasoning.effort`. Microsoft documents no
thinking setting for DeepSeek V4 Flash on Azure, so it offers Auto only and never receives a level.

**Context** is each model's Azure default (1.05M tokens for GPT-6, 1M for DeepSeek V4 Flash, 500K for
Grok 4.7); nothing trims the prompt. Each call carries a **reply cap**,
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
- **The hosted web app only.** The desktop app and the CLI talk to their own local runtime and do not
  offer included models; bringing them there is a later step.
- **Not on paired computers.** The Azure key never leaves the server, so a task that runs on your
  computer with an included tier fails with "Included models run on Ensemble's hosted assistant only.
  For tasks on your computer, pick your own API key or AI plan in Settings → Models."
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
- Nothing about credits appears when the server offers no included models.
- **Hosted defaults**: on a hosted server with included models, a tier still on the shipped Gemini
  default reads as an included model unless the account saved a Google key of its own
  (`apps/hub-api/src/included/defaults.ts`): Low and Medium use the first everyday model (GPT-6
  Luna), High the first step-up model (GPT-6.1 Sol), Max the same at High thinking. A tier
  someone chose is never changed.

## 7. API

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/metrics/credits` | Signed-in account (class `personal`: in a shared space, your own) | `IncludedUsage`: `available`, `models`, `period`, `resetsAt`, `limit`, `used`, `remaining`, `paused`, `totals`, `byModel`, `byPurpose`, `days`. Credits only |
| POST | `/api/internal/included/reserve` | agent-runtime, `x-ensemble-internal` + `x-ensemble-user` | `{model, inputTokens, maxOutputTokens, purpose?}` → `{id}`, or the 429/503 body above |
| POST | `/api/internal/included/settle` | agent-runtime | `{id, usage: {inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens} \| null, answeredBy?}` → `{credits}` |

`GET /api/models` lists the included models as one more provider (`source: "included"`, levels Low to
High in `meta`) when the server offers them; it carries no key and no price.

## 8. Operator settings

| Variable | Default | Meaning |
|---|---|---|
| `AZURE_FOUNDRY_RESOURCE` | (none) | The Foundry resource name, such as `ensemble-ai`, not a URL |
| `AZURE_FOUNDRY_API_KEY` | (none) | The resource's key. Server-only: never returned by `/api/credentials`, the catalog or any page |
| `ENSEMBLE_INCLUDED_MODELS` | all four | Comma list of the deployments to offer, or `off` (the kill switch). An id Ensemble does not include stops startup of included AI with an error |
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
