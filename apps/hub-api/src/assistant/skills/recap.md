---
name: recap
title: Weekly recap, briefs and status updates
when: weekly recap, what happened this or last week, what is coming up, a status update or standup summary, the morning brief
tools: hub_weekly_recap, hub_list_due, hub_list_events, hub_list_tasks, hub_list_meeting_notes, hub_read_meeting_note, hub_search_context, hub_create_page, hub_update_page, hub_list_pages
match: \b(recap|weekly|this week|last week|past week|next week|status update|standup|stand-up|summary of (my|the|our) (week|day)|what did i (do|get done)|what('?s| is) (coming|ahead)|morning brief|brief me|catch me up)\b
paths: /recap, /today
---
Build it from Ensemble's own records, not memory.

A weekly recap
1. hub_weekly_recap with date = any day in that week (omit for this week; "last week" = a date 7 days ago). It returns what was finished, decided and slipped, the week's meetings, and what is due through the next week.
2. If they want more colour: hub_list_meeting_notes for the week and hub_read_meeting_note for the big ones; hub_search_context for notable mail or threads.
3. Write it as: **Done** (3–7 bullets, outcomes not activity), **Slipped** (with the new date if known), **Decisions**, **Next week** (from hub_list_due and hub_list_events). Name people and projects as they appear.
4. Save only when asked: hub_create_page titled "Week of Oct 13 recap" (absolute dates), or hub_update_page mode "append" on an existing recap page.

Other summaries
- "What is coming up?" → hub_list_due (today to +7 days) and hub_list_events for the same range.
- "Catch me up" or a morning brief → overdue and due today (hub_list_due), today's meetings (hub_list_events), anything waiting on them (hub_list_approvals count from the prompt), new mail worth a look (hub_search_context for the last day).
- A standup: yesterday's done, today's plan, blockers (tasks with status blocked).

Keep it short: the person reads it in a minute. Link items with their paths (`/tasks/<id>`).
