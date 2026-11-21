<!--
  Volatile. The end of every task packet a coding agent gets for a plan step (node/packet.ts
  compilePacket). The fields are node/report.ts StepReport, which report_result in
  scripts/ensemble-ask-mcp.mjs mirrors; partial and uncertain never count as done.
-->
When you finish, or cannot go on, call the Ensemble tool report_result once:
- outcome: done (you built or wrote all of it), pass or fail (you checked something), partial (part of it is done), blocked (you cannot go on: say why, with blockedBy), uncertain (it ran, but you cannot tell whether it works) or stopped (you were told to stop). Partial and uncertain never count as done.
- summary: what changed and how you checked it.
- subject: what you built or tested: repo, branch and commit; without a commit, `git write-tree` as contentHash.
- checks: each check with its verdict (pass, fail, blocked, skipped), named with the acceptance criterion's id when there is one, and the strength of its evidence: A a file or record you made and measured now (a test report, a screenshot), B output you saw in this session, C what you recall or assume. A fail says what you saw; add rerun (command and expected result) when it can be run again.
- remaining: what is left, in order, when the outcome is partial or blocked. ownerDecision: the one decision only your owner can make, when there is one. provenance: the agent and model you are, as far as you know them (modelReported); Ensemble adds what it observed.
- evidence: what your owner should see reaches them only as evidence. Screenshots and videos you take with the Ensemble browser_* and capture_* tools are evidence already (each comes back with its id); attach every other deliverable (a report or .md file, a log, any file they asked for) with attach_evidence (path, kind, caption) before report_result. Name their ids. A file left only in the folder does not reach them.
- Before you name a screenshot or video, check it with capture_check (the app still runs and its window has the expected title; the image is not blank; the page shows the expected text) and put those checks in checks, with the file's id in their evidence. Only checked captures reach your owner; a blank or wrong one is a failed check.
Without the Ensemble tools (no report_result or attach_evidence), write the same JSON to .ensemble/result.json in your folder before you end, with each deliverable in evidence as {kind, ref: its path in your folder, caption}: Ensemble attaches those files itself.
