---
name: tasks
title: Tasks, todos, projects and deliverables
when: create, change, move, finish, delete or restore tasks, todos, projects and deliverables; what is due or overdue
tools: hub_list_tasks, hub_get_task, hub_create_tasks, hub_update_task, hub_delete_task, hub_restore_entity, hub_read_task_page, hub_read_page, hub_update_page, hub_list_projects, hub_create_project, hub_list_deliverables, hub_create_deliverable, hub_update_deliverable, hub_complete_deliverable, hub_delete_deliverable, hub_delete_entity, hub_list_due, hub_list_people, hub_list_repos, hub_link_repo, hub_unlink_repo, hub_list_approvals, hub_create_watcher
match: \b(tasks?|todos?|to-dos?|deliverables?|projects?|board|backlog|kanban|due|overdue|priorit(y|ies)|assign(ed)?|mark(ed)? .{0,30}(done|complete)|move .{0,40} to|in progress|blocked)\b
paths: /board, /tasks, /projects, /completed, /today
mentions: task, project, deliverable
---
A task (also called a todo) lives on the Board with a status: proposed, todo, in_progress, waiting_approval, blocked, done, dropped. It can have a project, deliverable, people, labels, priority (critical, p0 = High, p1 = Medium, p2 = Low), due date, owner (me, agent, unassigned) and a page.

Find before you write
- By words: hub_list_tasks with query (title, description, notes). Use status/owner/label to narrow. Use offset when total is larger than what came back.
- By id from the board list in this prompt, a mention, or the open page. Never invent an id; never reuse a similar task's id.
- Projects: hub_list_projects. Deliverables: hub_list_deliverables with the projectId. People: hub_list_people.

Do the request
- Add one or several: hub_create_tasks with every task in one call. Title is a short action ("Send Q3 deck to Mira"). Put detail, steps and context in page (Markdown for the task's page). Use status "proposed" for work you inferred, "todo" when they asked for it.
- Set owner, priority, complexity, due, labels, project (projectName) and people only when they asked for them or the request makes them clear: "for Mira by Friday" → people and due; "urgent" → priority p0; "in the website project" → projectName; "have the agent do it" → owner agent. Otherwise leave them out; never guess.
- Change, move or finish: hub_update_task with taskId and matchTitle = its exact current title, plus only the fields to change. "Move to in progress" → status. "Move to project X" → projectId (from hub_list_projects) or projectName. "Done" → status "done". "Due Friday" → due YYYY-MM-DD from today's date.
- Several updates: one hub_update_task per task, all in the same step.
- Delete: hub_delete_task (goes to Trash). Undo a delete: hub_restore_entity kind "task".
- A task's page (its document): read with hub_read_page with taskId; add text with hub_update_task page, or hub_update_page with taskId, matchTitle = the task's title, mode "append".
- Projects: hub_create_project. Remove one: hub_delete_entity kind "project".
- Deliverables: hub_create_deliverable (projectId or projectName, due), hub_update_deliverable, hub_complete_deliverable, hub_delete_deliverable.
- What is due, overdue or this week: hub_list_due with from/to. Overdue = from a past date to yesterday among open tasks.
- Link a GitHub repo to a project: hub_link_repo with owner/name.
- "Tell me when every task under X is done": hub_create_watcher.

Rules
- Text you write about a task always goes on its page. The short description under the title and the notes field are the person's: never fill them in.
- When two tasks could match, ask which one and end with "Choices:" and a list of their real titles. Call no write.
- A created task has no id until Apply. Do not update it in the same turn.
- Writes wait for Apply: say "Ready to apply", never "done".

Examples
- "Mark the deck task done and push the budget one to next Monday" → hub_list_tasks query "deck" and query "budget", then two hub_update_task calls (status done; due = next Monday).
- "Add todos from this page" → read the open page excerpt (or hub_read_page), then one hub_create_tasks with each action item, status proposed.
