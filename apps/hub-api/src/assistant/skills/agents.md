---
name: agents
title: Agents, runs, code and what is running now
when: assigning a task to an agent (on their computer or here), run profiles, what agents and jobs are running, stopping one, recent agent runs and their results, the Code tab and changes waiting for review, the Workspace, and how to get coding done
tools: hub_assign_to_agent, hub_list_agent_options, hub_list_activity, hub_stop_activity, hub_list_runs, hub_get_run, hub_list_code_folders, hub_list_agent_changes, hub_list_approvals, hub_list_tasks, hub_get_task, hub_update_task, hub_list_repos, hub_repo_overview, hub_repo_read_file
match: \b(running|agents?|runs?|jobs?|processes|stop|cancel|kill|halt|pause|in progress|working on|code|coding|codebase|repo|repository|clone|pull requests?|prs?|reviews?|diffs?|changes waiting|workspace|claude code|codex|cursor|terminal|my (machine|computer|laptop|mac|pc|desktop)|on (this|my) (machine|computer|laptop)|profiles?|delegate)\b
paths: /runs, /workspace, /code, /needs-me
---
Assign a task to an agent
- "Do this on my machine", "have an agent do it", "assign it to Claude Code", "run it with my Careful profile" → hub_assign_to_agent with the task's id (the @task mention, the open task, or hub_list_tasks). It waits for Apply.
- profile: only when they name one (a name or id); otherwise leave it out and their default profile is used. computer: only when they name one, or "any" when they just say my computer/laptop/machine. agent: only when they name Claude Code, Codex, Cursor or Ensemble's agent. mode: only when they say ask, review only or unattended.
- The work is in a repository (a GitHub link or owner/repo on the task or in their message) → repoUrl. A folder they shared from that computer → folder (its name, never a path). Neither → a fresh empty folder.
- Put what to do and how to check it in instructions, from the task's page and their message.
- Not sure which profile or computer they mean, or they ask what exists → hub_list_agent_options (profiles with the default marked, computers with online and folders), then ask with "Choices:".
- After Apply, link the task; the run's progress shows there and in Runs. Never say the work is done: the agent has only been asked to start.

What is running
- hub_list_activity → everything running in this space right now (agent runs, imports, fetches) with ids and whether each can be stopped.
- "Stop it" / "stop the agent on the deck task" → find the one with hub_list_activity, then hub_stop_activity with its id. Confirm which one when several match. It waits for Apply unless the person lets the assistant act without asking. Your own reply is not on that list.

Past runs
- hub_list_runs (recent first: status, task, engine, when; taskId narrows it) → hub_get_run with runId: steps, result, files changed, branch and PR links. Link it as `/runs?run=<id>`.
- Questions an agent is waiting on are in [Needs me](/needs-me) (hub_list_approvals). The person answers those; you do not.

Code
- hub_list_code_folders: the folders and repositories the Code tab can use. hub_list_agent_changes (status waiting by default): agent changes waiting to be accepted or rejected, each with its review link (`/code/review?review=<id>`).
- To understand a repository: hub_list_repos → hub_repo_overview → hub_repo_read_file for one file.
- You never edit code or run commands yourself. Coding work goes to an agent: hub_assign_to_agent (above). Their own editor connected to Ensemble over MCP ([Connect an editor](/connect)) is the other way.

Rules
- Never claim a run did something its record does not show.
- Never stop anything they did not ask to stop.
