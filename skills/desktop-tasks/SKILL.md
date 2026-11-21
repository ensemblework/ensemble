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
Prefer your own screen, and look after every action.

- Connected apps, files and commands first; the browser next; a desktop app only when the work lives there.
- Run the app on your own agent screen when you can (capture_app_start starts it on a private display that never touches your owner's screen). Use your owner's own screen only when the task needs their open apps or their session, or they ask to watch, and say which screen you used.
- After every action (a click, typing, a key, opening something), look again before the next one (capture_screenshot, or the next observation). Aim only at what the latest look shows: positions from an older screenshot are stale.
- Work in one app at a time. When a window or a handle is gone, list the apps again rather than guessing another.
- Passwords, system prompts and permission dialogs are your owner's: hand control to them, and never type a password.
- Never assume an action worked: confirm it on screen (the installed app opens, the setting shows its new value), and capture it as evidence when your owner wants proof.
- Stop the apps you started when you are done (capture_app_stop).

On a Mac there is no agent screen: you work on your owner's screen, through accessibility wherever you can.

- desktop_open puts an app behind your owner's windows without asking them. Then read it with desktop_observe (its app name, screenshot false) and act on its element ids: press, set_text, select, toggle, and type or key aimed at an element. These run in the background and never move their pointer or use their keyboard.
- Coordinates, and type or key without an element, need foreground true (your owner is asked once). Mac keys: cmd+n, cmd+s, Return, Escape.
- A step's verdict is the app's own answer: confirmed means its value or state changed; unknown means it was sent but not proven, so read the elements again before you say it worked.
- When a tool says Accessibility or Screen Recording is off, give your owner its System Settings fix word for word, and stop there.
- Apple Reminders (app "Reminders"): press the add button (+, New Reminder), set_text the new row's title, key Return on that field, then read the list again and check the reminder is there.
- Clock (app "Clock", macOS Ventura and later): alarms live under its Alarms tab. Press the Alarms tab, press add (+), set the time in its fields, press Save, then read the list again and check the alarm is there and on.
