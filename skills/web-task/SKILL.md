---
name: web-task
description: Use when the work is several steps on a site your owner uses: a dashboard, console, portal, admin or settings page, billing, usage, invoices or orders, or a form to fill in.
license: FSL-1.1-MIT
metadata:
  priority: p1
  keywords: dashboard, dashboards, console, consoles, portal, portals, admin, fill in, fill out, form, forms, navigate, click through, billing, usage, invoice, invoices, order history, my orders, my account, settings page
  tools: web_task
  source: Ensemble Node's multi-step web work skill.
---
- Dashboards, consoles and forms: web_task with the goal (and the url or tab). It clicks, types and reads step by step and returns what it found.
- After a sign-in it goes on: call web_task again with the same goal and tab.
- It never buys, pays, deletes or sends anything unless your owner's words ask for that.
- If it returns human_check or blocked, say so plainly.
