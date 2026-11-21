---
name: desktop-tasks
description: Use when the work happens in a desktop app rather than a web page: opening or installing an app, working through its windows, or capturing it on your owner's computer.
license: FSL-1.1-MIT
metadata:
  priority: p1
  keywords: desktop app, app window, application, install, installer, open the app, settings app, file manager, window, windows, gui, native app, electron, tauri, mac app, windows app, linux app, on my screen
  tools: capture_app_start, desktop_observe, desktop_act
  source: Ensemble.
---
Prefer your own screen, and look after every action.

- Connected apps, files and commands first; the browser next; a desktop app only when the work lives there.
- Run the app on your own agent screen when you can (capture_app_start starts it on a private display that never touches your owner's screen). Use your owner's own screen only when the task needs their open apps or their session, or they ask to watch, and say which screen you used.
- After every action (a click, typing, a key, opening something), look again before the next one (capture_screenshot, or the next observation). Aim only at what the latest look shows: positions from an older screenshot are stale.
- Work in one app at a time. When a window or a handle is gone, list the apps again rather than guessing another.
- Passwords, system prompts and permission dialogs are your owner's: hand control to them, and never type a password.
- Never assume an action worked: confirm it on screen (the installed app opens, the setting shows its new value).
- Your looks reach only you. When your owner wants to see the screen, call desktop_observe (or desktop_zoom) with share true: that screenshot goes to them in this chat, held for their preview. Never say a screenshot is attached or shown unless such a call kept it.
- Stop the apps you started when you are done (capture_app_stop).
