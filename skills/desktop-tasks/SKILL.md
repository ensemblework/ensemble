---
name: desktop-tasks
description: Use when the work happens in a desktop app rather than a web page: opening or installing an app, working through its windows, or capturing it on your owner's computer.
license: FSL-1.1-MIT
metadata:
  priority: p1
  keywords: desktop app, app window, application, install, installer, open the app, settings app, file manager, window, windows, gui, native app, electron, tauri, mac app, macos, windows app, linux app, on my screen, apple reminders, reminders app, clock app, alarm on my mac
  tools: capture_app_start, desktop_observe, desktop_act
  source: Ensemble.
---
- Connected apps, files, commands, the browser first; a desktop app only when the work is there.
- Prefer your agent screen (capture_app_start); your owner's only for their open apps or if they ask to watch; say which.
- Look again after every action; aim only at the latest look.
- One app at a time; a window gone, list the apps again.
- Passwords, system and permission dialogs are your owner's: hand them control; never type a password.
- Confirmed (value or state changed) is proof; else check on screen before saying it worked.
- Your looks reach only you: to show the screen, desktop_observe or desktop_zoom with share true (held for their preview); never claim a screenshot otherwise.
- Stop the apps you started (capture_app_stop).

On a Mac, no agent screen: use your owner's, through accessibility.

- desktop_open opens an app behind their windows; desktop_observe reads it (app name, screenshot false). Element-id actions (press, set_text, type, key…) run in the background.
- Coordinates, and type or key without an element, need foreground true (asked once). Keys: cmd+n.
- Typing without an element may stop early and says how much went in: look, type the rest.
- Not browser windows (minimised too): use the browser tools.
- Accessibility or Screen Recording off: give your owner the tool's fix (for Cua Driver, never Ensemble) word for word, and stop.
- Reminders: add (+), set_text the title, Return. Clock alarm: Alarms tab, add (+), set the time, Save. Reread the list.
