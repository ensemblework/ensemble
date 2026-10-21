# 33. Included AI and Ensemble credits

A hosted operator can offer configured Azure AI Foundry deployments and pay for their calls. Every verified account then gets **20,000 Ensemble credits a month** to spend on them without a key of its own. People see credits only, never dollars. When the operator's monthly ceiling is reached, every included call stops for everyone until the 1st, even for accounts with credits left.

Code: `apps/hub-api/src/included/`, `packages/shared-types/src/included.ts`, `apps/hub-api/src/runtime/included.ts` and `apps/agent-runtime/ensemble_agent/included.py`. Included AI exists only when the Azure variables are set (§8).

## 1. The models

Provider id `ensemble`, shown as **Included with Ensemble**. The model id is also the Azure deployment name. The catalog is `INCLUDED_MODELS` in `packages/shared-types/src/included.ts`; it does not check live Azure availability or quota.

| Model | Shown as | API on Azure | Thinking | Typical cost | Role | Offered |
|---|---|---|---|---|---|---|
| `gpt-6-luna` | GPT-6 Luna (2026-09-22) | Responses, `openai` host | Auto (Medium), Low, Medium, High | 1× | everyday | By default |
| `deepseek-v4-flash` | DeepSeek V4 Flash | Chat Completions, `services` host | Auto only | about 2× | everyday | By default |
| `gpt-6.1-sol` | GPT-6.1 Sol (2026-09-29) | Responses, `openai` host | Auto (Medium), Low, Medium, High | about 20× | step-up | By default |
| `grok-4.7` | Grok 4.7 | Responses, `services` host | Auto (High), Low, Medium, High | about 20× | step-up | By default |
| `gpt-5-mini` | GPT-5 mini (2025-08-07) | Responses, `openai` host | Auto (Medium), Low, Medium, High | about 3× | everyday | Only when named in `ENSEMBLE_INCLUDED_MODELS` |
| `gpt-4.1-mini` | GPT-4.1 mini (2025-04-14) | Responses, `openai` host | Auto only (no reasoning) | about 4× | everyday | Only when named |

Hosts: `openai` is `https://{resource}.openai.azure.com/openai/v1`, `services` is `https://{resource}.services.ai.azure.com/openai/v1` (then `/responses` or `/chat/completions`). "Typical cost" is a turn of 25,000 input and 1,000 output tokens relative to GPT-6 Luna. GPT models always use the Responses API with `store: false` (GPT-6.1 Sol takes function tools only there). Both runtimes send the key in the `api-key` header, no temperature or `top_p`, and no fallback model.

**Thinking levels** are Auto, Low, Medium and High (`modelEfforts("ensemble", …)` in `model-efforts.ts`); Extra high and Max are refused. Auto sends no level, so the model uses its default; a level goes in `reasoning.effort`. Models without levels (DeepSeek V4 Flash, GPT-4.1 mini) offer Auto only.

**Context** is the deployment's own; there is no context-size choice, and the usual caller and tool-result bounds apply. Every call carries a **reply cap**, `ENSEMBLE_INCLUDED_MAX_OUTPUT_TOKENS` (default 16,000; `max_output_tokens`, or `max_completion_tokens` on Chat Completions). Reasoning tokens count against it, it bounds a call's cost before it runs (§3), and Azure counts it against the deployment's tokens-per-minute quota when the request starts.

The transports also support Foundry's Anthropic Messages endpoint (`api: "anthropic"`) for a Claude deployment an operator adds; no catalog model uses it. For it, a tool round sends back Claude's exact content for that turn, thinking blocks included (kept in memory by tool-use id, up to 2,000 turns); if Azure still refuses over thinking blocks, the request is retried once without them and with thinking off.

## 2. Credits

- 1,000 credits = $1 of model cost at the provider's list price (`CREDITS_PER_USD` in `included/config.ts`). The dollar ledger never leaves hub-api.
- Credits belong to the **account**: a space spends its owner's credits; in a space shared with you, the call is yours, as with model keys ([28](28_ENSEMBLE_SPACES.md), [29](29_SHARING.md)).
- The month is the **UTC calendar month**; credits reset at 00:00 UTC on the 1st and do not carry over. Deleting workspace data, switching spaces or devices, or recreating an account with the same email does not renew the allowance.
- Background work on an included tier (document summaries, skill mining, the model test) spends the same credits as chat.

## 3. How a call is metered

`included/budget.ts` and `included/accounting.ts`; tables `included_usage`, `included_periods` and `included_credit_balances`. One `included_periods` row per month is the lock every reservation and settlement takes.

1. **Reserve.** Before calling Azure, the runtime asks hub-api to reserve the most the call could cost: every input token uncached plus the full reply cap, at the model's rates. Input is counted as the request body's UTF-8 bytes; byte-level tokenizers never make more tokens than bytes, so this is an upper bound (about four times the real count for English). Under the month's row lock, hub-api refuses when
   - the operator's spend plus open reservations plus this call would pass `ENSEMBLE_INCLUDED_TOTAL_MONTHLY_USD` → `included_paused` (429), or
   - the account's spend plus open reservations plus this call would pass its credits → `included_credits_used` (429), with how many credits the call could need and how many are left.

   A refused call holds nothing and never reaches Azure. The Python runtime calls `POST /api/internal/included/reserve`; the in-process runtime calls the same function. If hub-api cannot be asked, Azure is not called: "Ensemble could not check your credits just now. Try again in a moment." (`included_unavailable`).
2. **Call** Azure once; retries of a transient error stay inside the same reservation.
3. **Settle** with what Azure reported (`POST /api/internal/included/settle`): input tokens, cache reads, cache writes and output tokens, priced by `included/pricing.ts` with cache rates and, for the whole request, long-prompt rates when input passes 272,000 tokens (GPT-6 models) or reaches 200,000 (Grok 4.7). A request Azure refused, or that never reached it, settles at zero. A request that stops without reported usage (Stop, a timeout, a dropped connection) is charged its reservation, since Azure may have billed it. Settling twice keeps the first. If settling fails, the reply still arrives and the reservation expires (step 4).
4. A reservation not settled within 30 minutes (`STALE_RESERVATION_MS`, e.g. a crashed runtime) is **expired** at its reserved amount by the next reservation.

So calls in flight cannot overrun either limit, and the ceiling is checked against real token counts rather than Azure billing data (8–24 hours late). Each call's cost in credits is also recorded on the `model.call` metric (`credits`, with `estimatedUsd` null) and on run steps. Before a chat opens its stream, `POST /api/assistant/turn` makes the cheap version of the check (`assertIncludedOpen`) so a person without credits hears at once.

`included_credit_balances` holds only a purpose-separated HMAC of the account email, the UTC month and the amount used (reservations included). When a month's balance is first created (`accountBalance`), call rows without a balance key are added to it once, and, after an Everything erasure that removed call rows, so are the credits recorded on that month's included `model.call` metrics from before the erasure; nothing is estimated.

## 4. Where included models run

- **The hosted assistant** (chat, Ask, page and comment answers) and server `complete()` callers. Hosted production uses the Python runtime (`ensemble_agent/included.py`); a TypeScript copy (`apps/hub-api/src/runtime/included.ts`) runs in-process in development and tests.
- **The desktop app and the CLI on a computer connected to an account** (paired: Settings → Account → This computer in the app; `ensemble login` with *Run tasks* approved in the CLI; [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)). They hold no Azure key and no ledger. Their local server (`included/device.ts`) reads the account's included models and credits from `GET /api/devices/self/included` (cached for a minute) and sends each included call to `POST /api/devices/self/included/turn` with its device token. Ensemble's server runs it with `includedTurn` on that account's credits, under the same monthly ceiling, and returns the turn or the refusal (§5). Chats, the model menu, Settings → Models, Metrics and the CLI's `/model` list them. A computer's tiers are its own and never switch to included models by themselves.
- **Not on a local-only computer.** A desktop app or CLI not connected to an account lists included models as unavailable (`code: "included_local_only"` on the `/api/models` row) and refuses every included call with `included_local_only`: the app shows *Included models need your Ensemble account* with **Connect this computer**, the CLI a notice pointing at `/login`.
- Server workspace jobs stay operator-only ([06](06_MODULE_WORKSPACE_AND_SURFACES.md)).

## 5. When a call cannot run

| Code | Status | When | What people read |
|---|---|---|---|
| `included_credits_used` | 429 | The account's credits are used up, or this call could pass them | "You've used this month's Ensemble credits. They reset on Nov 1. To keep going now, add your own API key or AI plan in Settings → Models." (or the credits the call could need and how many are left) |
| `included_paused` | 429 | The operator's monthly ceiling is reached | "Ensemble's included AI is paused for everyone until Nov 1: this month's shared budget is used up, even for accounts with credits left. Your own API keys and AI plans still work (Settings → Models)." |
| `included_unavailable` | 503 | Not set up or switched off, a model the operator did not deploy, or hub-api could not be asked | "Included AI is not set up on this server…" |
| `included_local_only` | 403 | A desktop app or CLI not connected to an account, or whose computer was removed | "Included models need this computer connected to your Ensemble account: they run on Ensemble's server and use your account's credits. Connect it in Settings → Account → This computer, or use your own API key or AI plan (Settings → Models)." |

The date in the messages is the actual reset date. The body is `{code, error, message, resetsAt, status}` (`IncludedErrorBody`), as an HTTP response or the assistant stream's `error` frame. Like a provider quota, the sentence is shown in the chat but not stored as an assistant message.

## 6. What people see

- **Settings → Assistant → Models** (`components/settings/models.tsx`, `model-picker.tsx`, `lib/included.ts`): the provider picker's **Included** tab comes first, is remembered, and shows the credits left or "paused until Nov 1". Picking it sets the tier to the first everyday model on Auto. Models show by name and version with a cost badge relative to GPT-6 Luna; typed names are not accepted. Thinking reads "Auto (Medium)" (the model's default), Low, Medium, High, or Auto only. A line under the API keys row shows credits left and the reset date, linking to Metrics; tiers say when credits are used up or included AI is paused.
- **Metrics**: an **Ensemble credits** card (`GET /api/metrics/credits`, `components/metrics/included-credits.tsx`): credits left, reset date, whether the shared budget is paused, input and output credits with token counts (and cached input tokens), and credits by model, purpose and day. An information icon explains credits used before deleted usage history, which still count. Call lists, the daily tooltip and purposes show credits instead of a dollar estimate; the provider filter lists *Included with Ensemble*.
- **Errors**: the chat and *Ask Ensemble* show the server's sentence (§5) in their error banner; it is not stored, does not mark the model "out of quota", and refreshes credits and the model list.
- **Reply footer**: *Ensemble included* with the model's name and version.
- **The assistant's model menu** (the Low/Medium/High/Max button under the chat box, `components/assistant/assistant-dock.tsx`) lists included models under *Included with Ensemble* with the credits left. Picking one sends that model with every message of the chat on Auto (`model`, `provider: "ensemble"`, `reasoningEffort: "default"` on `POST /api/assistant/turn`); picking a tier returns to the tier's model.
- Nothing about credits appears when the server offers no included models. A local-only desktop app or CLI shows the *Included models need your Ensemble account* notice in Settings → Models, Metrics and the model menu (`IncludedLocalOnly`).
- **Default tiers** (`included/defaults.ts`, hosted only): a tier whose provider has no key the account can use (none saved, and not an operator with that provider's server key) reads as an included model. That covers the shipped Gemini default for everyone without a Google key. Low and Medium use the first offered everyday model, High the first step-up model, Max the same at High thinking. Tiers on the account's own key, an AI plan (Claude Code, Codex…) or Cursor are never changed. Saving settings keeps what was read.

## 7. API

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/metrics/credits` | Signed-in account (class `personal`: in a shared space, your own) | `IncludedUsage`: `available`, `models`, `period`, `resetsAt`, `limit`, `used`, `erasedCredits`, `remaining`, `paused`, `totals`, `byModel`, `byPurpose`, `days`. Credits only |
| POST | `/api/internal/included/reserve` | agent-runtime, `x-ensemble-internal` + `x-ensemble-user` | `{model, inputTokens, maxOutputTokens, purpose?}` → `{id}`, or the 429/503 body |
| POST | `/api/internal/included/settle` | agent-runtime | `{id, usage: {inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens} \| null, answeredBy?}` → `{credits}` |
| GET | `/api/devices/self/included` | A paired computer's device token only | `{catalog, usage}`: the `/api/models` row and `IncludedUsage` for its account |
| POST | `/api/devices/self/included/turn` | A paired computer's device token only (rate bucket `model`, body up to 16 MB) | `{model, messages, items?, jsonMode?, reasoningEffort?, chatTools?, responsesTools?, purpose?}` → `{turn}` with `credits`, or the 403/429/503 body. The account comes from the token, never the body |

`GET /api/models` lists the included models as one more provider (`source: "included"`, levels Low to High in `meta`), with no key and no price. On a desktop app or CLI the row comes from the account's server, or is unavailable with `code: "included_local_only"`; `GET /api/metrics/credits` there returns the account's credits, or `available: false, localOnly: true`.

## 8. Operator settings

| Variable | Default | Meaning |
|---|---|---|
| `AZURE_FOUNDRY_RESOURCE` | (none) | The Foundry resource name, such as `ensemble-ai`, not a URL |
| `AZURE_FOUNDRY_API_KEY` | (none) | The resource's key. Server-only: never returned by `/api/credentials`, the catalog or any page |
| `ENSEMBLE_INCLUDED_MODELS` | The four default models | Comma list of deployments to offer (from §1), or `off`. A wrong value (an unknown id, a URL as the resource) turns included AI off and hub-api logs "Included AI is off: …" |
| `ENSEMBLE_INCLUDED_MONTHLY_CREDITS` | 20000 | Credits per account per month |
| `ENSEMBLE_INCLUDED_TOTAL_MONTHLY_USD` | 180 | Model cost across all accounts per month, in USD |
| `ENSEMBLE_INCLUDED_MAX_OUTPUT_TOKENS` | 16000 | Reply cap per call, reasoning included (max 128000) |

hub-api and agent-runtime read the same values from `/etc/ensemble.env`. An Azure budget only alerts (a day late) and does not stop spending; keep one on the subscription anyway as a second net. Deployment runbooks are private, not in `docs/`.

## 9. Data and retention

`included_usage` keeps one row per included call: account, space, month, model, purpose, status, token counts and the dollar cost behind the credits; never prompt or reply text. Deleting everything scrubs model, purpose, token counts, answer source and input/output cost splits; a pending reservation keeps only what settlement needs, then is scrubbed too. Scrubbed rows appear in no detailed aggregate. Call rows are deleted with the account.

`included_credit_balances` (§3) survives workspace erasure and account deletion, so recreating an account cannot refresh credits; the scheduler removes ended months after a two-day settlement grace. It holds no prompts, replies, readable email or workspace content. `included_periods` keeps each month's total across all accounts and is not deleted with an account, so deleting an account does not return its spend to the ceiling ([07](07_MODULE_GOVERNANCE_AUDIT_METRICS.md)).

Opening Metrics after an Everything erasure (`repairErasedUsage` in `lib/workspace-data.ts`, once per erasure) first secures the months' charges in the balance, then removes metric events and baselines from before the erasure; later calls and workspace content stay, and repeated reads keep the same balance.

## 10. Limits

- Tests (`apps/hub-api/src/included/*.test.ts`) use recorded request and usage shapes, not live Azure calls.
- Prices are a table in code (`pricing.ts`). If a provider changes a rate, the table must change with it or the ceiling is counted at the old rate.
- The reservation is an upper bound only if Azure stops each reply at the cap. Microsoft documents that the cap includes reasoning for GPT-6 and Grok 4.7, not for DeepSeek V4 Flash. A reply past its cap is still charged what Azure reported, and hub-api logs "settled above its reservation", so an account or the ceiling can pass its limit by that much.
- The upper-bound input estimate makes reservations large: near the end of an allowance, a step-up model can be refused ("could use up to … credits") while an everyday model still runs.
- Included calls are not streamed token by token; the reply arrives whole and the chat shows it in pieces.
- Credits are monthly only; there is no paid top-up or larger plan.
