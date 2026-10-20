# Check the Mac app

Build the disk image on this Mac, from the repo root:

```bash
pnpm desktop:dmg
```

The script prints the path to the `.dmg`. The build is unsigned.

The app and local Node/Prisma sidecar are built for the same chip. Use the Apple silicon installer on M-series Macs and the Intel installer on Intel Macs.

- [ ] Install from the `.dmg` and open it.
  Drag Ensemble to Applications. A normal double-click may be blocked the first time.
  macOS 14 and earlier: right-click the app, then Open, then Open again.
  macOS 15 and later: double-click it once, then System Settings > Privacy & Security > Open Anyway.

- [ ] The app window and the Woven Chorus icon.
  The window opens. The Dock icon is the Satin Gold Woven Chorus mark on its Deep Petrol tile.

- [ ] Enter a Gemini key and run a simple agent task.
  Settings → Assistant → Models → Manage API keys → Google Gemini. Paste a key from [Google AI Studio](https://aistudio.google.com/apikey).
  Workspace → Assign task → Research & writing. Ask for one sentence. The task finishes in the window.

- [ ] The folder picker.
  Assign task → Code on your computer → A folder on this computer → Choose….
  The macOS folder dialog opens, and the chosen path shows in the field.

- [ ] Check the macOS sandbox.
  Assign a code task in a folder you trust, and ask it to write a file outside that folder (for example `~/Desktop/ensemble-sandbox-probe.txt`).
  The file is not created. Writes stay inside the task folder. Commands run in the macOS sandbox.

- [ ] Plots export.
  Open Plots, then Export, and download a PNG.
  This uses the Mac's own `python3` with matplotlib. Ensemble does not bundle Python.
  If either is missing, the app says: "Plots need Python 3 with matplotlib on this computer. Install it, then try again."
  Install it with `python3 -m pip install matplotlib`, then export again. The file downloads.

- [ ] Pair with the web app on localhost and run an assigned task.
  In another terminal, from the repo root, run `pnpm dev` so the site is `http://localhost:3000` and the API is `http://127.0.0.1:4000`.
  In the browser: Settings → Devices → Pair a device. Copy the 8-character code.
  In the desktop app: Settings → Remote tasks (This Mac). Address `http://127.0.0.1:4000`. Paste the code. Pair. Turn on Allow remote tasks.
  `ENSEMBLE_SITE_URL` is only the site the window loads. The address above is the remote-tasks API.
  In the browser, assign a small task and choose this Mac under Run on. It runs on the Mac.

- [ ] Remove the Mac in web Settings and confirm it stops.
  In the browser: Settings → Devices → Revoke on that Mac.
  Within a couple of seconds the desktop status says: "Removed from Ensemble on the web. Pair again to keep running remote tasks."

Brand checks: run `pnpm brand:check` and `node scripts/check-icons.mjs`. Verify the startup mark, Finder/Dock icon, light/dark Hub, assistant minimized while active, and OS reduced motion.

The 0.3.8 runtime carries original page attachments and diagram source into claimed jobs through the leased attachment endpoint, with a 100 MB transfer cap. The download guide version matches the Tauri configuration.

## Settings regression checks (16 Oct 2026)

- Add a Code folder through **Choose folder…**; verify its git checkout appears in Code and can be reviewed. The picker must use the installed Tauri dialog plugin.
- Enable App notifications, grant macOS permission and send a test reminder. Denial leaves the setting off; system Focus still applies.
- On hosted Settings → Terminal and commits, unlock passkey management, then remove a disposable key. Locked removal must remain refused.
- Rename a paired machine and verify its name remains after a heartbeat. Sign out or uninstall the runner and check remote access ends. With a packaged app, deletion of its executable must be noticed by a surviving runtime’s next heartbeat.

These are manual release checks; compilation or simulated HTTP tests alone do not certify physical Touch ID, OS notifications or installer removal.

## Release consistency

Check About Ensemble against root `release.json`. Confirm the installer matches the Mac’s chip, the same version appears in the CLI, and About can check for updates. An active task must block installing an update. A 0.3.x install needs one manual installer download to bootstrap the signed updater.

Intel disk images use the APFS packager and a simple app/Applications layout. Verify the image opens and the bundle’s version matches the canonical release before publication. CI also creates/verifies a fixture image without Finder automation.

- In a disposable space, attach an existing file from the assistant and confirm it becomes an `@file:` mention without a connector search. Verify the compact board toolbar and Metrics provider/date filters. Exercise the Data Danger zone (typed phrase, no paste/drop, then final confirmation); deleting everything must clear local usage details while retaining account credit consumption.
