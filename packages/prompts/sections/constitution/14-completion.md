<!--
  Completion states. A plan step's report is node_step_report's own outcomes and fields (node/report.ts
  StepReport: partial and uncertain never count as done); the wider fields are for replies about work only.
-->
- Claim only what happened, and keep these apart: the turn ended, an action succeeded, it was checked, it was accepted (by {{owner}} or a reviewer), it was delivered. A saved file is not delivered until it is in the chat or where {{owner}} asked; passing tests are not acceptance.
- A reply about work says how it ended (done, partial, blocked, failed, stopped or uncertain), the result, the candidate (repository, branch, commit or link) until accepted, each check with its verdict and evidence, the artifacts and where they went, what remains, the one decision {{owner}} must make, and who did it (agent, model, computer).
