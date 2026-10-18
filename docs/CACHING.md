# Caching and transient state

Code inspected **18 Oct 2026**. Ensemble uses several kinds of caches; it is no longer accurate to describe all of them as process-local maps. Domain records remain authoritative in the database. Authenticated content must not be treated as public CDN data.

## Cache map

| Area | Storage / lifetime | Invalidation or boundary |
| --- | --- | --- |
| UI queries | React Query, per-query stale/GC settings | Scoped query keys and mutation/SSE invalidation; not durable offline synchronization |
| Navigation prefetch | Browser route/query prefetch dedupe | Short bounded href window; route-specific behavior |
| Provider discovery | `model_catalogs` database plus runtime caches | Credential fingerprint/key change, weekly freshness, failed-fetch retry and explicit refresh; metadata-only |
| Git stats/repository lists | Bounded process maps in Code/Git helpers | Short TTLs; edits are reflected on refresh/miss, not a second checkout cache |
| Repository mirror preparation | In-flight promise plus managed temporary checkout | Promise removed when settled; not cached private API JSON |
| Context suppressions | Bounded helper cache | Short TTL/invalidation around suppression changes |
| OAuth state, SSE tickets and passkey challenges | Short-lived single-use state in the owning store | Redeemed/expired; authorization state, not reusable content |
| Remote file/code/subscription relays | Bounded Redis transient request/answer state | Timeouts, ownership/token checks and expiry; not arbitrary durable file backup |
| Included catalog/credits on paired runtime | Short local read cache of the account's host response | Host remains authoritative for every reservation/call; not a local credit grant |
| Version/update discovery | API's bounded update-result cache | Five minutes, shorter after failure; signed packages/manifest still validated |
| Plot data/render preparation | Feature-specific bounded caches | Dataset/spec identity and owning plot implementation; [20](20_PLOTS_DESIGN.md#6-caching) |

Pause flags intentionally do not expire into automatic Resume. Device leases, user sessions and terminal unlocks have independent expiry; none is a generic data cache.

## Assistant prompts and cached tokens

`assistant/skills/index.ts` routes a small set of playbooks/tools; `state.ts` places stable instructions before live data. Personal skill bodies are read on demand. This can improve provider prefix reuse and reduce input compared with advertising every tool/body, but actual cache hits depend on the provider, prompt and timing. Usage uses reported cached-token counts; it does not invent a cache discount.

Private tool results are not shared across accounts as a prompt/result cache. Tool visibility, input schema and authorization are rechecked normally. Included-model reservations remain conservative even when a future call might hit the provider's prompt cache ([33](33_INCLUDED_AI.md)).

## Performance changes and measurement

Lazy-loading heavy editor/rendering modules and bounding reads are different from caching domain JSON. [UI_PERF_DESIGN](UI_PERF_DESIGN.md) explains current ownership and how to measure. Historical bundle/latency figures are explicitly historical and must not be quoted as today's production measurements.
