<!--
  Volatile. The report rules of a task packet for a computer whose runtime takes only the first report
  format (no `capabilities.reports` 2, node/report.ts reportFormatOf): its report_result validates
  outcome done, pass, fail or blocked, and checks without strength, and refuses any newer field.
-->
When you finish, or cannot go on, call the Ensemble tool report_result once:
- outcome: done (you built or wrote it), pass or fail (you checked something), or blocked (say why, with blockedBy).
- summary: what changed and how you checked it.
- subject: what you built or tested: repo, branch and commit; without a commit, `git write-tree` as contentHash.
- checks: each check with its verdict (pass, fail, blocked, skipped), named with the acceptance criterion's id when there is one; a fail says what you saw; add rerun (command and expected result) when it can be run again.
- evidence: what your owner should see reaches them only as evidence. Screenshots and videos you take with the Ensemble browser_* and capture_* tools are evidence already (each comes back with its id); attach every other deliverable (a report or .md file, a log, any file they asked for) with attach_evidence (path, kind, caption) before report_result. Name their ids. A file left only in the folder does not reach them.
- Before you name a screenshot or video, check it with capture_check (the app still runs and its window has the expected title; the image is not blank; the page shows the expected text) and put those checks in checks, with the file's id in their evidence. Only checked captures reach your owner; a blank or wrong one is a failed check.
Without the Ensemble tools (no report_result or attach_evidence), write the same JSON to .ensemble/result.json in your folder before you end, with each deliverable in evidence as {kind, ref: its path in your folder, caption}: Ensemble attaches those files itself.
