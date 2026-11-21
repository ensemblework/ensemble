---
name: routine-design
description: Use when you create or change a routine, a watcher, or any work that runs on a schedule, repeats, or runs while nobody is watching.
license: FSL-1.1-MIT
metadata:
  priority: p1
  keywords: routine, routines, every day, every morning, every week, daily, weekly, monthly, schedule, scheduled, recurring, remind me, watcher, watch for, monitor, notify me when, automatically, each time, cron
  tools: node_routines, hub_create_routine, hub_create_watcher
  source: Ensemble. A checkable goal with a boundary, a retry limit and a person on the last switch follow ECC loop-design-check (MIT, see THIRD_PARTY_NOTICES).
---
A routine runs while nobody watches, so its finish line must be checkable.

- Write the goal as a result a check can confirm ("a page with today's date and the three headlines, each with its link"), not as an effort ("look at the news").
- Name what it must not do: no sending, paying, deleting or posting to other people unless your owner asked for exactly that; the last step that cannot be undone waits for your owner's approval.
- Say what it does when it cannot finish: stop, keep what it found, and report why, instead of trying forever. Give retries a limit.
- Decide where the result goes (a page, a task, a message to your owner) and how your owner hears about a failure.
- Use your owner's time zone, and the lowest frequency that does the job.
- After you create it, run it once (or read its first run) and check the result before you call it set up.
