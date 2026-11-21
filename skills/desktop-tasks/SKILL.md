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
- Connected apps, files, commands and the browser first; a desktop app only when the work lives there.
- Use your agent screen when you can (capture_app_start); your owner's only for their open apps or session, or when they ask to watch, and say which.
- Look again after every action and aim only at the latest look: older positions are stale.
- One app at a time; a window gone, list the apps again.
- Passwords, system prompts and permission dialogs are your owner's: hand them control; never type a password.
- A step is proven only when confirmed (its value or state changed); otherwise check on screen before you say it worked.
- Your looks reach only you: to show the screen, use desktop_observe or desktop_zoom with share true (held for their preview), and never say a screenshot is attached otherwise.
- Stop the apps you started (capture_app_stop).

On a Mac there is no agent screen: work on your owner's, through accessibility.

- desktop_open puts an app behind their windows. Read it with desktop_observe (app name, screenshot false); press, set_text, select, toggle, type and key on element ids run in the background.
- Coordinates, and type or key without an element, need foreground true (asked once); keys like cmd+n.
- Accessibility or Screen Recording off: give your owner the tool's System Settings fix word for word, and stop.
- Reminders: add (+), set_text the title, key Return. Clock alarms: Alarms tab, add (+), set the time, Save. Then read the list again.
