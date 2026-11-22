---
name: desktop-tasks
description: Use when the work happens in a desktop app rather than a web page: opening or installing an app, working through its windows, or capturing it on your owner's computer.
license: FSL-1.1-MIT
metadata:
  priority: p1
  keywords: desktop app, app window, application, install, installer, open the app, settings app, file manager, window, windows, gui, native app, electron, tauri, mac app, macos, windows app, windows pc, notepad, microsoft store, winget, linux app, on my screen, apple reminders, reminders app, clock app, alarm on my mac
  tools: capture_app_start, desktop_observe, desktop_act
  source: Ensemble.
---
- Connected apps, files, commands, the browser first; a desktop app only when the work is there.
- Linux: prefer your agent screen (capture_app_start); your owner's only for their open apps or if they ask to watch; say which.
- Look again after every action; aim only at the latest look. One app at a time; a window gone, list apps again.
- Passwords, system and permission prompts (User Account Control too) are your owner's: desktop_handoff, say why, wait. Never type a password.
- Confirmed (value or state changed) is proof; else check the screen.
- Your looks reach only you: to show the screen, desktop_observe or desktop_zoom with share true.
- Stop the apps you started (capture_app_stop).

Mac and Windows: no agent screen; your owner's, through accessibility.

- desktop_open opens an app behind their windows; desktop_observe reads it (app, screenshot false). Element actions (press, set_text, type, key) run in the background.
- Coordinates, and type or key without an element, need foreground true (asked once). Keys: cmd+n on a Mac, ctrl+n on Windows.
- Typing may stop early and says how much went in: look, type the rest.
- Not browser windows, minimised too: browser tools.
- Mac permission off: give your owner the tool's fix (for Cua Driver, never Ensemble) word for word, and stop.
- Store apps: computer_run winget install, the id, source msstore, both agreement flags.
- Reminders: +, set_text the title, Return. Clock: Alarms tab, +, time, Save. Notepad: type, read it back.
