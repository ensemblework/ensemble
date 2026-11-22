---
name: stuck-recovery
description: Use when the same action failed twice, a step makes no progress, you are going in circles, a call keeps timing out, or you are waiting on something that does not come.
license: FSL-1.1-MIT
metadata:
  priority: p0
  keywords: stuck, still failing, same error, again and again, no progress, going in circles, loop, looping, keeps failing, timed out, timeout, hangs, frozen, nothing happens, retry, retries, gave up, blocked
  source: Ensemble. The capture, match and smallest recovery order follows ECC agent-introspection-debugging (MIT, see THIRD_PARTY_NOTICES).
---
Stop repeating and look at the pattern.

1. Write down what you tried, in order, and what each attempt showed. The same call with the same input gives the same result.
2. Name the kind of failure: a missing fact, a missing sign-in or permission, a tool that cannot do this, a wrong approach, an outside service that is down, or a limit.
3. Take the smallest step that changes something:
   - a missing fact: look it up in Ensemble, or ask your owner one short question;
   - a sign-in or a permission: ask your owner on a card (browser_login_needed, a secret request) and wait for it;
   - a tool that cannot do it: take another route (a connected app's tools, the browser, the computer, a coding agent);
   - a wrong approach: plan again from what you now know;
   - a service that is down: say so, and when to try again.
4. Two different approaches failed: stop and report. Say what you tried, what each showed, what you think the cause is, and the one decision or action that unblocks it.

Never claim progress you did not make. Never repeat an action that may already have taken effect (a payment, a sent message, a booking) without checking first whether it did.
