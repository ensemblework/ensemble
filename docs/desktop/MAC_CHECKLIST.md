# Check the Mac app

A hand test for a desktop build on a Mac ([DESKTOP](../DESKTOP.md)). Automated tests do not cover Touch ID, OS notifications, Gatekeeper or installer removal.

Build the disk image on the Mac, from the repo root:

```bash
pnpm desktop:dmg
```

The script prints the path to the unsigned `.dmg`. The app and its Node/Prisma sidecar are built for this Mac's chip; use the Apple silicon installer on M-series Macs and the Intel one on Intel Macs.

## Install and run

- [ ] **Install and open.** Drag Ensemble to Applications. The first double-click may be blocked.
  macOS 14 and earlier: right-click the app, Open, then Open again.
  macOS 15 and later: double-click once, then System Settings → Privacy & Security → Open Anyway.

- [ ] **Window and icon.** The window opens. The Dock icon is the Satin Gold Woven Chorus mark on its Deep Petrol tile.

- [ ] **Model key and a simple task.** Settings → Assistant → Models → Manage API keys → Google Gemini; paste a key from [Google AI Studio](https://aistudio.google.com/apikey). Workspace → Assign task → Research & writing; ask for one sentence. The task finishes in the window.

- [ ] **Folder picker.** Assign task → Code on your computer → Where it works: A folder on this computer → Choose…. The macOS folder dialog opens and the chosen path fills the field.

- [ ] **Sandbox.** Assign a code task in a trusted folder and ask it to write outside that folder (for example `~/Desktop/ensemble-sandbox-probe.txt`). The file is not created; commands run in the macOS sandbox.

- [ ] **Plots export.** Plots → Export → PNG. This uses the Mac's own `python3` with matplotlib. If either is missing the app says: "Plots need Python 3 with matplotlib on this computer. Install it, then try again." After `python3 -m pip install matplotlib`, the export downloads.

## Pairing

- [ ] **Pair with the web app on localhost and run an assigned task.**
  In another terminal at the repo root, run `pnpm dev` (site `http://localhost:3000`, API `http://127.0.0.1:4000`).
  In the browser: Settings → Connections → Connected computers → Connect a computer → Create connection code (8 characters, valid 10 minutes).
  In the desktop app: Settings → Account → This Mac. Address `http://127.0.0.1:4000`, paste the code, Pair, then turn on Allow remote tasks.
  (`ENSEMBLE_SITE_URL` only chooses the site the window loads; the address here is the remote-tasks API.)
  In the browser, assign a small task with Run on set to this Mac. It runs on the Mac.

- [ ] **Rename.** Rename the Mac under Connected computers; the name survives the next heartbeat.

- [ ] **Revoke.** In the browser: Connected computers → Revoke on that Mac. Within seconds the desktop shows: "Removed from Ensemble on the web. Pair again to keep running remote tasks."

- [ ] **Removal.** Signing out or `ensemble runner uninstall` ends remote access. With a packaged app, deleting its executable is noticed by a surviving runtime on its next heartbeat.

## Settings

- [ ] **Code folders.** Settings → Data → Terminal and commits → Choose folder…: the Tauri dialog opens; the folder's git checkout appears in Code and can be reviewed.
- [ ] **Notifications.** Settings → Notifications → App notifications: grant macOS permission and send a test. Denying leaves the setting off; Focus modes still apply.
- [ ] **Passkeys.** On the hosted Settings → Data → Terminal and commits, unlock passkey management and remove a disposable passkey. Removal while locked is refused.
- [ ] **Files and data.** In a disposable space: attach an existing file from the assistant and confirm it becomes an `@file:` mention without a connector search. Check the board toolbar and the Metrics provider and date filters. Use Settings → Data → Danger zone (typed phrase, no paste or drop, then a final confirmation): deleting everything clears local usage details but not the account's credit consumption.

## Release

- [ ] Settings → Account → About Ensemble matches root `release.json`, and the CLI shows the same version.
- [ ] The installer matches the Mac's chip.
- [ ] About can check for updates; an active task blocks installing one. Installs older than 0.4.0 need the current installer once.
- [ ] An Intel image opens with the app and an Applications link, and the bundle's version matches the release.
- [ ] Brand: `pnpm brand:check` and `node scripts/check-icons.mjs` pass. Check the startup mark, Finder and Dock icons, light and dark Hub, the minimized assistant while it works, and OS reduced motion.
