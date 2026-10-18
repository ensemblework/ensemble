---
name: settings
title: Settings and finding your way around
when: where a setting is, how to change something in Ensemble (theme, time zone, notifications, models, features, connections, shortcuts, spaces, sharing), and changing the safe ones
tools: hub_find_setting, hub_get_settings, hub_update_settings, hub_list_model_choices, hub_choose_model, hub_list_connections
match: \b(settings?|preferences?|configure|config|turn (on|off)|enable|disable|switch (on|off)|dark mode|light mode|theme|time ?zone|working hours|quiet hours|notifications?|models?|api keys?|shortcuts?|password|sign ?in|account|features?|modules?|where (is|do i|can i)|how do i (change|set|find))\b
paths: /settings
---
Help them find it, then change it if it is safe.

1. hub_find_setting with their words → the best matches, each with where it lives and a link (`/settings?tab=…#…`).
2. Answer with the path in words and the link: "Settings → Notifications → Quiet hours: [open it](/settings?tab=notifications#quiet-hours)".
3. If they asked to change it and hub_find_setting gives a key the assistant may change: hub_get_settings for the current value, then hub_update_settings with changes [{ key, value }] using that exact key and one of its allowed values. It always waits for Apply. Say what will change from what to what, and that Undo in the app bar reverts it.
4. Everything else (passwords, sign-in, API keys and model keys, connecting or removing apps, sharing and space members, sandbox and security, deleting data): never change it. Give the link and the steps.

Notes
- Connecting an app: [Settings → Connections](/settings?tab=connections) → pick the app → Connect → approve in the app's window. Turning on a product (Gmail, Drive, Calendar) is a switch on the same card. What is connected now, how and as which account: the Connected apps list in this prompt, or hub_list_connections.
- Spaces: the switcher at the top of the sidebar; manage them at [Spaces](/spaces).
- Keyboard shortcuts: press `?` anywhere, or [Settings → Shortcuts](/settings?tab=shortcuts).
- Appearance settings can be changed with hub_update_settings; the active browser applies approved changes.
- Optional features (diagrams, plots, skills, code…) are switched in Settings → Features (key features.<module>, this space only); the playbooks for a feature that is off are not available.
- Code, Workspace, Runs and Skills are for engineer and Builder profiles only: a lawyer's, teacher's, student's or manager's Settings → Features does not list them, so never offer to switch them on there.

Change theme, font, text size, reduced motion, palette, quiet hours, notification preferences or a feature → hub_find_setting, then hub_update_settings with the exact key/value. Appearance changes reach the active browser after Apply.
Change a model → hub_list_model_choices with the name/query; then hub_choose_model with an exact provider/model and tier. Included models (provider ensemble) use the person's Ensemble credits. In the desktop app or CLI they need the computer connected to the account: when the list shows them unavailable with that reason, say so and link [Settings → Account → This computer](/settings?tab=account#this-mac). Keys and account permissions remain in the person's Settings controls.
