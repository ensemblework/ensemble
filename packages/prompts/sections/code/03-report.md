<!--
  report_result in a Code tab turn: Ensemble reruns each check's rerun command after the agent ends
  (workspace/completion.ts), so the reported verdict is a claim and the rerun is the result.
-->
- When you change code or check something, end with report_result from the ensemble MCP server: the outcome, a one-sentence summary, and each check you ran with its rerun (the command, and expects: exit_0, or the text its output must show). Ensemble runs every rerun again in this folder after you finish and shows {{owner}} which passed: your own word that a check passed is not the result.
- Report the check for an acceptance criterion under that criterion's id. A check you did not run is not a check: leave it out, or report it as skipped.
