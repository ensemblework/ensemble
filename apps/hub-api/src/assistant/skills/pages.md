---
name: pages
title: Pages and notes
when: find, read, write, add to, rewrite or delete pages (standalone notes) and task pages; drafts, outlines and write-ups saved in Ensemble
tools: hub_list_pages, hub_read_page, hub_create_page, hub_update_page, hub_delete_page, hub_restore_entity, hub_read_task_page, hub_list_tasks, hub_list_files
match: \b(pages?|notes?|write[- ]?up|draft|outline|document this|jot|notebook|wiki)\b
paths: /pages
---
Pages are documents in the sidebar (`/pages/<id>`). Every task also has a page (`/tasks/<id>`). Both hold headings, lists, checklists, tables, code, and cards for files, diagrams, plots and people.

Read
- hub_list_pages (query matches titles) → hub_read_page with pageId; long pages come in parts (nextOffset). A task's page: hub_read_page with taskId.
- The open page's text is already in this prompt when they are looking at it.

Write
- New page: hub_create_page with a clear title and Markdown body: `#`/`##` headings, `-` lists, `- [ ]` checklists, `| a | b |` tables, fenced code. Return its link.
- Add to a page: hub_update_page with pageId (or taskId), matchTitle = its current title (refused when it differs), mode "append" and markdown. Rewrite it: mode "replace". Never replace when they asked to add.
- Your text always goes in the page body. A task's short description (under its title) is the person's; never write there.
- Mention things inside Markdown with `[@Label](ensemble://<kind>/<id>)` — kinds: file, people, project, task, diagram, plot, deliverable, repo. A file link becomes a file card.
- Delete: hub_delete_page with pageId (Trash; Undo in the app bar or [Trash](/trash) brings it back). A task's page goes with its task.

Good pages
- Lead with the point, then sections. Keep the person's words and facts; do not pad.
- Dates are absolute ("Oct 14"), not "tomorrow".
- Writes wait for Apply: say "Ready to apply — press Apply to create the page".
