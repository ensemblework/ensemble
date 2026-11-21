---
name: independent-review
description: Use when a deliverable is ready for your owner's acceptance, a step reports success that later steps build on, or your owner asks for a review, an audit or a second opinion.
license: FSL-1.1-MIT
metadata:
  priority: p0
  keywords: review, reviewer, second opinion, check it, look over, audit, critique, feedback on, proofread, quality check, acceptance, accept, sign off, independent check
  tools: node_helper, node_delegate, node_plan
  source: Ensemble. The reviewer's brief, "do not trust the report" and the list of what was not judged follow superpowers requesting-code-review (MIT, see THIRD_PARTY_NOTICES).
---
A review is done by someone who did not do the work and who does not trust the report.

Give the reviewer (a helper, or a verify step in a crew plan):
- the original request and what done means, word for word;
- the artifact itself (the page, the file, the diff, the link), never a summary of it;
- the evidence the worker gave, marked as a claim to check.

Ask the reviewer to:
- check each requirement against the artifact and say pass, fail or could not check, with where it looked;
- list what is missing, what is extra and what is wrong, the most serious first, judged by the effect on your owner;
- name what it did not judge, and why (no access, needs a person).

Act on the review: fix what failed, by the same worker when it can, then have the fix checked again. Tell your owner the verdict with its evidence. Never present your own check as an independent one.
