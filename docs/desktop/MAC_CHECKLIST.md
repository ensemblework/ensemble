# Check the Mac app

Use this checklist to verify a [desktop build](../DESKTOP.md) on a Mac. Test installation, account connection, task execution and settings before checking the release. Touch ID, OS notifications, Gatekeeper and installer removal need these manual checks.

Build the disk image on the Mac, from the repo root:

```bash
pnpm desktop:dmg
```

Open the `.dmg` at the path printed by the script. Use the Apple silicon installer on M-series Macs and the Intel installer on Intel Macs. The app and its Node/Prisma sidecar are built for the Mac’s chip.

## Install and run

- [ ] **Install and open.** Drag Ensemble to Applications. The first double-click may be blocked.
  macOS 14 and earlier: right-click the app, Open, then Open again.
  macOS 15 and later: double-click once, then System Settings → Privacy & Security → Open Anyway.

- [ ] **Window and icon.** Confirm that the window opens and the Dock shows the Satin Gold Woven Chorus mark on its Deep Petrol tile.

- [ ] **First run.** With no `~/Library/Application Support/com.ensemblework.desktop/mode.json`, the start page asks *With your Ensemble account* or *Only on this computer*. For the local-only checks below choose *Only on this computer*; the bundled Hub opens, and Settings → Account offers *Move to your Ensemble account*.

- [ ] **With an account.** On a second user account (or after deleting the data folder), choose *With your Ensemble account*. The browser opens `/link` with a code that matches the app; approve. The window opens Today on the account, and Settings → Connections → Connected computers lists this Mac once. Sign out in the window: the login page shows *Continue in your browser*, which signs it in again without pairing a second computer.

- [ ] **Move to an account.** In local-only mode, add a task and a page, then Settings → Account → Move to your Ensemble account → Continue in your browser, approve with *Move this computer's local-only data* ticked. The window opens the account, which now has the task and the page; quitting and reopening opens the account, not the local Hub.

- [ ] **Model key and a simple task.** Settings → Assistant → Models → Manage API keys → Google Gemini; paste a key from [Google AI Studio](https://aistudio.google.com/apikey). Workspace → Assign task → Research & writing; ask for one sentence. The task finishes in the window.

- [ ] **Folder picker.** Assign task → Code on your computer → Where it works: A folder on this computer → Choose…. The macOS folder dialog opens and the chosen path fills the field.

- [ ] **Sandbox.** Assign a code task in a trusted folder and ask it to write outside that folder (for example `~/Desktop/ensemble-sandbox-probe.txt`). The file is not created; commands run in the macOS sandbox.

- [ ] **Plots export.** Plots → Export → PNG. This uses the Mac's own `python3` with matplotlib. If either is missing the app says: "Plots need Python 3 with matplotlib on this computer. Install it, then try again." After `python3 -m pip install matplotlib`, the export downloads.

## Pairing

These steps pair an app kept local only from an earlier version; an app with an account pairs when it signs in (above).

- [ ] **Pair with the web app on localhost and run an assigned task.**
  In another terminal at the repo root, run `pnpm dev` (site `http://localhost:3000`, API `http://127.0.0.1:4000`).
  In the browser: Settings → Connections → Connected computers → Connect a computer → Create connection code (8 characters, valid 10 minutes).
  In the desktop app: Settings → Account → This Mac. Address `http://127.0.0.1:4000`, paste the code, Pair, then turn on Allow remote tasks.
  (`ENSEMBLE_SITE_URL` only chooses the site the window loads; the address here is the remote-tasks API.)
  In the browser, assign a small task with Run on set to this Mac. It runs on the Mac.

- [ ] **Rename.** Rename the Mac under Connected computers. Wait for its next heartbeat and confirm that the name remains.

- [ ] **Revoke.** In the browser: Connected computers → Revoke on that Mac. Within seconds the desktop shows: "Removed from Ensemble on the web. Pair again to keep running remote tasks."

- [ ] **Removal.** Signing out or `ensemble runner uninstall` ends remote access. With a packaged app, deleting its executable is noticed by a surviving runtime on its next heartbeat.

## Desktop control

Desktop control works from the app's own runtime and from a runner the `ensemble` command line started, both through the installed app's Cua Driver ([25 §11.9](../25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#119-macos-setup-and-permissions)). Start with Ensemble, Cua Driver and your terminal off under both lists below.

- [ ] **Driver.** `Ensemble.app/Contents/Resources/sidecar/bin/` holds `CuaDriver.app`, `ensemble-disclaim`, `CuaDriver.LICENSE` and `CuaDriver.THIRD_PARTY_NOTICES.md`. `codesign -dv` on `CuaDriver.app` shows `TeamIdentifier=YCK386LBJ7`, and `codesign --verify --deep --strict` on it passes.
- [ ] **Permissions off.** A node's `desktop_status` names Accessibility and Screen Recording as off for Cua Driver, each with its System Settings › Privacy & Security fix and the path of `CuaDriver.app`. macOS asks once, naming Cua Driver (never Ensemble), and asks again no sooner than ten minutes later. If macOS first asks whether to open an app from the internet, confirm it and note it here.
- [ ] **Accessibility.** Turn on Cua Driver under Accessibility. Without quitting the app, `desktop_status` shows it on. `desktop_open` Reminders opens it behind the front window, and `desktop_observe` with app Reminders and screenshot false lists its elements.
- [ ] **Screen Recording.** Turn on Cua Driver under Screen & System Audio Recording. `desktop_observe` returns a screenshot of the main display, and a zoom of it is sharp.
- [ ] **Cua Driver outside Ensemble.** Ensemble is still off under Accessibility and Screen & System Audio Recording. With Cua Driver on, ask a node to run these with `computer_run`, and write down here what each one did (whether macOS asked, whether the picture shows other apps' windows): `D=/Applications/Ensemble.app/Contents/Resources/sidecar/bin/CuaDriver.app/Contents/MacOS/cua-driver`, then `"$D" serve &`, `sleep 3`, `"$D" call check_permissions`, `"$D" call get_desktop_state '{"max_image_dimension":256}' --screenshot-out-file probe.png` and `"$D" stop`. [25 §11.9](../25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#119-macos-setup-and-permissions) says they can work without any ask (a sandboxed command cannot reach the daemon's socket, so note whether `call` was refused). Then `/Applications/Ensemble.app/Contents/Resources/sidecar/bin/ensemble-disclaim /bin/echo mcp --direct` exits 64.
- [ ] **Ensemble holding a grant.** Turn Ensemble on under Screen & System Audio Recording: within ten minutes (the next readiness check) a node's desktop calls other than `desktop_status` are refused, saying Ensemble itself is allowed it, with the fix. Turn it off again and, within a minute, desktop control comes back.
- [ ] **A reminder.** Ask a node to create a reminder in Apple Reminders. It works through elements in the background, and the reminder is in the list.
- [ ] **An alarm.** Ask a node to set an alarm in Clock (macOS Ventura and later), under its Alarms tab. The alarm shows in Clock and is on.
- [ ] **Your pointer.** A step with `foreground` asks once on a card; after allowing it, a click lands where the screenshot shows, and a click on Ensemble's own window is refused.
- [ ] **Typing.** Ask for a `type` of a few hundred characters in TextEdit with `foreground` and touch nothing: all of it arrives and the step is not `partial`. One of 5,000 characters arrives whole too; note how long it took (a `partial` that ran out of time says how many characters went in). Again, and switch to another app while it types: the step ends `partial` saying the window in front changed. Again, and press a key yourself: it ends saying you used the keyboard or mouse. Again, and stop the node's mission (or quit the app) while it types: typing stops within a chunk.
- [ ] **Browsers.** With a Hub tab open in Safari in a window you minimise, an element action in that window is refused (`unknown_page`). The same in a browser Ensemble does not know by name.
- [ ] **Recording.** On macOS 15 and later `desktop_record` start and save gives an MP4 held for preview; on macOS 14 it says video needs macOS 15.
- [ ] **Command-line runner.** With the app installed, `ensemble runner start` from a terminal: `desktop_status` works and the grants are still Cua Driver's.
- [ ] **After an update.** Install a newer build: Cua Driver keeps its grants, and nothing asks again.

## Settings

- [ ] **Code folders.** Settings → Agents → Terminal and commits → Choose folder…: the Tauri dialog opens; the folder's git checkout appears in Code and can be reviewed.
- [ ] **Notifications.** Settings → Notifications → App notifications: grant macOS permission and send a test. Denying leaves the setting off; Focus modes still apply.
- [ ] **Passkeys.** On the hosted Settings → Agents → Terminal and commits, unlock passkey management and remove a disposable passkey. Removal while locked is refused.
- [ ] **Files and data.** In a disposable space: attach an existing file from the assistant and confirm it becomes an `@file:` mention without a connector search. Check the board toolbar and the Metrics provider and date filters. Use Settings → Data → Danger zone (typed phrase, no paste or drop, then a final confirmation): deleting everything clears local usage details but not the account's credit consumption.

## Release

- [ ] Settings → Account → About Ensemble matches root `release.json`, and the CLI shows the same version.
- [ ] The installer matches the Mac's chip.
- [ ] About can check for updates; an active task blocks installing one. Installs older than 0.4.0 need the current installer once.
- [ ] An Intel image opens with the app and an Applications link, and the bundle's version matches the release.
- [ ] **Downloaded copy.** Download each release `.dmg` in a browser, so it is quarantined, and copy Ensemble to Applications. `codesign --verify --deep --strict --verbose=2 /Applications/Ensemble.app` reports `valid on disk`. Opening it gives the warning for an unidentified developer, never "damaged"; Privacy & Security › **Open Anyway** opens it ([DESKTOP §7](../DESKTOP.md#7-releases-and-updates)).
- [ ] **Update from an older build.** An app from an older release updates in-app to this one, restarts and opens, and `codesign --verify --deep --strict` passes on the updated app.
- [ ] Brand: `pnpm brand:check` and `node scripts/check-icons.mjs` pass. Check the startup mark, Finder and Dock icons, light and dark Hub, the minimized assistant while it works, and OS reduced motion.
