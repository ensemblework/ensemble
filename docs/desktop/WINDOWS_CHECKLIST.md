# Check desktop control on Windows

Use this checklist to verify desktop control on a Windows 10 or 11 PC with a [desktop build](../DESKTOP.md) or the `ensemble` command line. GitHub's Windows runners run the parts a test can (`.github/workflows/desktop-windows-smoke.yml`, [25 §11.13](../25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#1113-tests-and-limits)); these are the ones that need a real PC, a person at it and a paired account. How it works: [25 §11.11](../25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#1111-windows-setup-and-the-session-probe) and [§11.12](../25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#1112-windows-how-control-works-and-limits).

Sign in to Windows as a standard user (not an administrator) for the checks, so User Account Control prompts show as they do for most owners.

## Install and pair

- [ ] **Install.** Run the NSIS installer (`.exe`) or the MSI for the PC's architecture (x64 or arm64). SmartScreen may warn about an unsigned app: More info, Run anyway. The app opens.
- [ ] **Driver.** The installed `sidecar\bin` folder holds `cua-driver.exe`, `CuaDriver.LICENSE` and `CuaDriver.THIRD_PARTY_NOTICES.md`. In PowerShell, `Get-AuthenticodeSignature <that folder>\cua-driver.exe` shows `Valid`, signed by Cua AI, Inc. The same files are in the command line's zip under `ensemble\sidecar\bin`.
- [ ] **Pair.** Sign in with an Ensemble account (or pair as in the [Mac checklist](MAC_CHECKLIST.md#pairing): Settings → Connections → Connected computers → Connect a computer, then the code in the app). Settings → Connections → Connected computers lists the PC once.

## Readiness

- [ ] **Ready.** Ask a node for `desktop_status` on the PC. The owner's screen is ready: `driver` names Cua Driver 0.56.6 (and says so when Ensemble runs as administrator, which it should not), `session` is working, `uia` answers, `dpi` gives the main monitor's size and scale (try 100% and 150% in Settings → Display), `capture` shows a real screenshot's size, and the agent screen says Windows has none. Nothing asks for a permission.
- [ ] **No ffmpeg.** Without ffmpeg installed, `recorder` is failed with the fix `winget install Gyan.FFmpeg`, and `desktop_record` start answers the same, never a fake video.
- [ ] **Locked.** Lock the PC (Windows+L) and ask for `desktop_observe`: it is refused as locked. Unlock: it works again.
- [ ] **Service.** Run `ensemble` as a Windows service, or in session 0 if you have a way to: `desktop_status` says session 0 has no screen, with what to do.

## Notepad

- [ ] **Open behind.** Ask a node to open Notepad. It opens without taking the front from the window you are using, and no card asks anything.
- [ ] **Type behind.** Ask it to add a line to Notepad's text without your screen. On Windows 11's Notepad the text arrives without your pointer moving or Notepad taking the front. On Windows 10's Notepad the step says the field did not take it and to click into it (it never claims it typed), and nothing arrives.
- [ ] **Type.** Ask it to type "Ensemble 0.9.1 on Windows" in Notepad. It asks once on a card for your pointer and keyboard ("This mission"); after that it brings Notepad forward, the text arrives whole, and reading Notepad's elements shows the same text. A second typing step in the same mission does not ask again. If Windows keeps your window in front instead, the open step says Notepad did not come to the front, never that it did, and the node clicks into Notepad.
- [ ] **Clicks land where aimed.** On a display at least 1920 pixels wide (screenshots are smaller than it), at 100% and at 150% (Settings → Display), ask it to click into the middle of Notepad's text by its place on a screenshot, then to type a word: the word goes where the screenshot showed the click.
- [ ] **Switching windows stops typing.** With an always-on-top window open (a video's picture-in-picture), ask for a long text and click into the Ensemble app while it goes in: typing stops at the next chunk, saying the window in front changed, and nothing arrives in Ensemble.
- [ ] **Your input wins.** Ask for a long text (a few hundred characters) and type something yourself while it goes in: the step ends `partial`, saying how many characters went in and that you used the keyboard, and the agent waits two minutes after your last input.
- [ ] **Floor.** With the Ensemble app's window open beside Notepad, ask the node to click on the Ensemble window by its position, and to press a button in it by its element: both are refused (`ensemble_window`). A Hub tab in Edge, also minimised, is refused (`unknown_page`).
- [ ] **Floor across virtual desktops.** On desktop 1 open Ensemble, then File Explorer over part of it; on desktop 2 maximise Notepad; go back to desktop 1. A click by position on the part of Ensemble that shows is refused (`ensemble_window`), not judged against the hidden Notepad. With a browser the node does not know by name (Avast Secure Browser, Iron or Supermium, installed and showing the Hub), a click or element action in its window is refused.
- [ ] **Sensitive apps.** Ask it to read Windows PowerShell's window: it asks once on a card as a terminal; Settings asks as system settings. Neither is refused.
- [ ] **Close without saving.** Ask it to close Notepad without saving: Notepad closes (alt+F4 in front, then "Don't save" when asked), no file was written, and the step never says the keys did not run.

## A screenshot of a named window

- [ ] Ask a node to show you a screenshot of the Notepad window ("show me Notepad"). It brings Notepad forward or looks at the screen, shares the picture (`share`), and the card holds it for your preview first. The picture is sharp at 150%.

## A short recording

- [ ] Install ffmpeg (`winget install Gyan.FFmpeg`) and restart Ensemble. `desktop_status` now shows `recorder` working. Ask for a 10-second recording of the screen while the node types in Notepad: the saved MP4 is held for your preview and plays.

## The Microsoft Store and User Account Control

- [ ] **Install Notion from the Store.** Ask a node to install Notion from the Microsoft Store. It uses `computer_run` with `winget install --id XPDBVSS44R0L9H --source msstore --accept-package-agreements --accept-source-agreements` and never clicks through the Store's agreements itself.
- [ ] **User Account Control.** If Windows shows a User Account Control prompt during the install (or ask for an install that needs one), the node does not click or type in it: a desktop call says a User Account Control prompt is open and only you can answer it, the node hands it to you (`desktop_handoff`, with a notice on the PC saying what it is for) and waits. Answer it; the node goes on, and Notion is in the Start menu.
- [ ] **Run as administrator.** Open Notepad as administrator and ask the node to type in it: it says the window belongs to an app running as administrator and hands it to you.

## Command line

- [ ] With the app closed, `ensemble runner start` from a terminal: `desktop_status` works through the command line's own `cua-driver.exe`.
