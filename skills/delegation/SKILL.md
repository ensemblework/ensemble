---
name: delegation
description: Use when work splits into parts that can run on their own, or another node, crew member, helper or coding agent should do part of it.
license: FSL-1.1-MIT
metadata:
  priority: p0
  keywords: delegate, hand off, hand over, assign, crew, team, helper, helpers, in parallel, at the same time, split, divide, coding agent, agent session, claude code, codex, copilot, cursor, someone else, another node
  tools: node_delegate, node_helper, node_session_start, node_plan, node_work_start
  source: Ensemble. The brief and the rule that whoever delegates owns the result follow superpowers dispatching-parallel-agents (MIT, see THIRD_PARTY_NOTICES).
---
Give each worker a brief, never your conversation.

A brief says:
- the goal in one sentence, and why it matters;
- exactly what to produce and where it goes;
- the facts it needs: names, links, values, files, copied in (never "see above");
- the limits: what not to touch, and what needs your owner's approval;
- how the result will be checked, and what to report back: the result, the evidence, what is left.

Split only where the parts do not share work in progress: two workers must never edit the same file or record at once. Independent parts can run at the same time; a part that needs another's result runs after it.

Pick the worker by the work: code to a coding agent session (node_session_start) or a developer in the crew; a side question or an independent check to a helper (node_helper); several members to one plan (node_plan).

You own the result. A worker's report is a claim: check what it made before you pass it on (the verify-before-done skill). When a worker is blocked, read why and decide: give it what it lacks, change the plan, or ask your owner. Never send the same task back unchanged.
