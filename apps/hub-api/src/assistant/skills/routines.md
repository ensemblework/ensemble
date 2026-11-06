---
name: routines
title: Routines: work the assistant does on a schedule
when: something recurring the assistant should do by itself (every morning, each weekday, on Mondays, every hour), or listing, pausing, changing or deleting a routine
tools: hub_list_routines, hub_create_routine, hub_update_routine, hub_list_connections
match: \b(routines?|every (morning|evening|day|night|weekday|week|month|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|each (morning|evening|day|weekday|week|month)|on a schedule|daily at|weekly on|recurring (task|job|check))\b
paths: /routines
---
A routine is work you do by yourself at set times, with the person's own tools and connected apps: a morning inbox digest, a Monday plan, a Friday board tidy. Each run is a turn of yours in the routine's own conversation; its result goes to the bell and the Routines page.

Adding one
1. Only when they ask for something recurring. A meeting that repeats is a calendar event (calendar playbook), and a one-off nudge is a reminder.
2. If it reads an app (Gmail, Calendar, Slack, …), check it is connected with hub_list_connections; if not, say so and offer Settings › Connections, then still add it if they want.
3. hub_create_routine: a short title; an instruction that stands on its own (it runs with no one to ask), e.g. "Read my unread Gmail from the last 24 hours and list what needs a reply, most urgent first, with one line each"; the schedule as every (hour, day, weekday, week, month) with time HH:MM in their time zone, days for week, dayOfMonth for month. cron only for what those cannot say.
4. Say when it runs next and that its results arrive in the bell.

Changing one
- hub_list_routines for ids, then hub_update_routine: action pause, resume or delete, or edit with only the fields that change.
- "Stop the digest" → pause unless they say delete.

Inside a routine's own run, do not add or change routines: just do the work and report.
