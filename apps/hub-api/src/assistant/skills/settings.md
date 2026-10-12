---
name: settings
title: Settings and finding your way around
when: where a setting is, how to change something in Ensemble (theme, time zone, notifications, models, features, connections, shortcuts, spaces, sharing), and changing the safe ones
tools: hub_find_setting, hub_get_settings, hub_update_settings
match: \b(settings?|preferences?|configure|config|turn (on|off)|enable|disable|switch (on|off)|dark mode|light mode|theme|time ?zone|working hours|quiet hours|notifications?|models?|api keys?|shortcuts?|password|sign ?in|account|features?|modules?|where (is|do i|can i)|how do i (change|set|find))\b
paths: /settings
---
Help them find it, then change it if it is safe.

1. hub_find_setting with their words → the best matches, each with where it lives and a link (`/settings?tab=…#…`).
2. Answer with the path in words and the link: "Settings → Notifications → Quiet hours: [open it](/settings?tab=notifications#quiet-hours)".
3. If they asked to change it and hub_find_setting gives a key the assistant may change: hub_get_settings for the current value, then hub_update_settings with changes [{ key, value }] using that exact key and one of its allowed values. It always waits for Apply. Say what will change from what to what, and that Undo in the app bar reverts it.
4. Everything else (passwords, sign-in, API keys and model keys, connecting or removing apps, sharing and space members, sandbox and security, deleting data): never change it. Give the link and the steps.

Notes
- Connecting an app: [Settings → Connections](/settings?tab=connections) → pick the app → Connect → approve in the app's window. Turning on a product (Gmail, Drive, Calendar) is a switch on the same card.
- Spaces: the switcher at the top of the sidebar; manage them at [Spaces](/spaces).
- Keyboard shortcuts: press `?` anywhere, or [Settings → Shortcuts](/settings?tab=shortcuts).
- Theme (light or dark), font, text size and motion are kept by each browser, so you cannot change them: point to the account menu's theme switch or Settings → Appearance.
- Optional features (diagrams, plots, skills, code…) are switched in Settings → Features (key features.<module>, this space only); the playbooks for a feature that is off are not available.
