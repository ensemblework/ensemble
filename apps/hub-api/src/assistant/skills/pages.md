---
name: pages
title: Pages and notes
when: find, read, write, add to, rewrite or delete pages (standalone notes) and task pages; drafts, outlines and write-ups saved in Ensemble
tools: hub_list_pages, hub_read_page, hub_create_page, hub_update_page, hub_delete_page, hub_delete_pages, hub_restore_entity, hub_read_task_page, hub_list_tasks, hub_list_files, hub_read_page_blocks, hub_edit_page, hub_move_page, hub_export_page_file, hub_run_workflow, hub_manage_record, hub_read_record_details
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
- Bulk delete: hub_delete_pages with pageIds from hub_list_pages. All selected pages and descendants share one Undo entry; one click restores the entire batch.
- Delete: hub_delete_page with pageId (Trash; Undo in the app bar or [Trash](/trash) brings it back). A task's page goes with its task.

Good pages
- Lead with the point, then sections. Keep the person's words and facts; do not pad.
- Dates are absolute ("Oct 14"), not "tomorrow".
- Writes wait for Apply: say "Ready to apply — press Apply to create the page".

Precise edit: hub_read_page_blocks returns revision, paths and exact block Markdown. hub_edit_page takes these plus replace, replace_text, insert_before, insert_after or delete. Unchanged blocks stay intact. Use replace_text for a phrase while preserving its formatting. Paths in multiple edits refer to the document after the preceding edit.
Move a page → hub_move_page. Export → hub_export_page_file. Dependent creates → hub_run_workflow.

Other record maintenance → hub_manage_record (restore one trashed record, page/task conversion, supported plot/diagram/dataset actions, file tags and internal comments). Use the relevant real ID; it preserves the app's existing access and deletion rules.
