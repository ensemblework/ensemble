# Check the Mac app

Build the disk image on this Mac, from the repo root:

```bash
pnpm desktop:dmg
```

The script prints the path to the `.dmg`. The build is unsigned.

The app shell is universal, but the local API inside it uses this Mac's Node and Prisma engine. Test on a Mac with the same chip as the one that built it.

- [ ] Install from the `.dmg` and open it.
  Drag Ensemble to Applications. A normal double-click may be blocked the first time.
  macOS 14 and earlier: right-click the app, then Open, then Open again.
  macOS 15 and later: double-click it once, then System Settings > Privacy & Security > Open Anyway.

- [ ] The app window and the Two voices icon.
  The window opens. The Dock icon is the Two voices mark.

- [ ] Enter a Gemini key and run a simple agent task.
  Settings → Models → API keys → Google Gemini. Paste a key from [Google AI Studio](https://aistudio.google.com/apikey).
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
