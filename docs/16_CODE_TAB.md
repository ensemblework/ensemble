# 16 · The Code tab — review, rewrite, commit (and a guarded terminal)

The **Code** item in the sidebar lists every run that changed files. Opening one gives an IDE-like review of exactly what the agent changed, hunk by hunk, and the tools to finish the job without leaving Ensemble: accept or reject a change, edit anything yourself right there, look at the whole file, commit, push, open a pull request, or use a small terminal for git.

**Hosted public accounts:** the hosted server's own folders, repository operations and shell are operator-only (`lib/hosted-access.ts`). `ENSEMBLE_TERMINAL=off` overrides user settings; hosted production defaults to off even for operators. Your own code is on your paired computer, and the Code tab on the web works on it there (below).

Failed review/repository queries display the actual error and Retry; they never claim that no work exists. A denied terminal-status request settles into an error instead of “Opening the terminal…”. Hosted guidance points to a paired computer for local execution/review, not a way to obtain host privileges (`app/(hub)/code/page.tsx`, `components/code/terminal.tsx`).

**On Ensemble on the web** (an account without host access; 14 Oct 2026), the tab works on your paired computers (`components/code/computers-code.tsx`). Each computer shows its **agent changes to review** and its **repositories** (the folders Code may use there and Ensemble's workspace), read from that computer. Opening one gives the same review page as on the computer (`/code/review?device=<id>&review=<id>` or `&repo=<path>`): accept or reject each change, edit any file, the whole file, Source control (stage, commit, push, pull, Actions), the IDE theme, and the **Terminal**, unlocked with your passkey on the web (§5). Every call is made by Ensemble on that computer, through Ensemble on the web (doc [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md) §4.7, `lib/code-target.tsx`): only by you, in your browser (never an API key, an agent or the assistant); never git's own files or secrets files; keys in code hidden, and a file that holds one is read-only from the web; files over 1 MB read-only. The computer's own switches decide what the web may do: *Show task files on the web* (reading), *Change code from the web* (every change) and *Terminal from the web* (Settings → this computer, or `ensemble web`). It needs the CLI 0.3.8 or the desktop app 0.3.5 there, online; otherwise the computer's card says which.

Below, **Runs on your computers** (`components/code/device-changes.tsx`) lists each code run from the last two weeks with its computer, folder label, branch, the files it changed with lines added and removed, pull request or commit links, *Review & edit* (its review on that computer), *Open code*, *View run* and *Open task*. A repository the agent cloned is not counted as a change; what it changed inside one is. The task page's *Review changes* opens the same review.

**Open code** (`components/code/run-code.tsx`, `/code?job=<id>&file=<path>`) shows the run like an editor: on the left the files the agent changed (A, M or D, with line counts), then *Folder on <computer>*, the task's whole folder as a tree; on the right the file, read-only, highlighted by language (CodeMirror). A changed file opens from the copy the computer sent when the run ended (*as the run left it*); *Now* reads it again from the computer. The folder is read from the computer only when you open it, one folder or file at a time (doc [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md) §4.6): never git's own files or secrets files, text only, large files cut, secrets redacted. Full screen fills the window like an IDE (Esc leaves it). Only the person whose computer ran the task sees the files' text (others in a shared space see names and line counts). It needs Ensemble 0.3.7 (CLI) or 0.3.4 (desktop app) on that computer, the computer online for the folder, and *Show task files on the web* on there (`ensemble browse on`); otherwise it says which. Links are followed only to where they really lead inside the folder, and the same rules apply there. The run preview's *Files* and the task page's *Agent output* link here.

With no paired computer, it says how to set one up. The hosted server's own *Local repositories* and terminal are not shown there; each computer's are.

---

## 1. Using it

The review opens as an IDE (`components/code/ide.tsx`, 14 Oct 2026): an activity bar (Explorer, Find in files, Source control, Terminal), the side panel, tabs for the files you open, the editor, the terminal under it and a status bar (branch with ahead/behind, the review's progress, the computer it is on, line and column, language, line endings, the save state, code size). The editor is CodeMirror's merge view (`components/code/review-editor.tsx`, `@codemirror/merge`).

| You want to… | Do this |
|---|---|
| See what a run changed | Code → click the run (or *Review changes* on the task page, *Review & edit* on a run on your computer) |
| Keep an agent change | *Accept* on it, or Alt+Y with the cursor in it. Nothing on disk changes — it is already there |
| Undo an agent change | *Reject*, or Alt+N. The old lines go back on disk; Ctrl+Z brings the change back |
| Change something yourself | Just type, in either view. Your edits show in **blue** with *Revert* (Alt+N) |
| Put a file back as the run left it | *Restore the run's version* in the file bar (drops your edits and rejects in that file) |
| Read / edit the whole file | *File*, or F4 — folding, change bars in the gutter, same document as the Changes view. A file with nothing to review opens whole |
| Open any file | The explorer's *Folder* tree, or *Go to file* at its top (tracked and new files) |
| Find text in the files | *Find in files* in the activity bar (fixed text, match case optional; up to 500 results) |
| Move around | F7 / Shift+F7 next/previous change (past the last, the next file), Alt+→ / Alt+← next/previous changed file |
| Find / replace in the file | Ctrl+F |
| Focus | Full screen button (Esc leaves), Ctrl+B explorer, `?` shortcuts (outside the editor) |
| Resize the explorer | Drag its right edge (up to half the width; double-click resets; arrow keys when focused) |
| Code text size | The size in the status bar, or Ctrl+Shift+= / Ctrl+Shift+- / Ctrl+Shift+0 (10–24 px, editor and terminal only) |
| Commit / push | *Source control* in the activity bar |
| Run git yourself | The terminal button in the activity bar, or Ctrl+` |

It is an **editor first**. Type anywhere — in the Changes view or the whole-file view — and it is saved automatically (0.7 s after you stop, on Ctrl+S, when you switch file or view, and before a commit or push). The status bar and the tab show `• Unsaved` → `Saving…` → `Saved`. A save names the version of the file the editor read (`expectedHash`); if something else wrote the file meanwhile, nothing is overwritten (below). Saves keep the file's own line endings and byte-order mark (`lib/code-versions.ts`).

**No shortcut is a bare letter or an editing key:** every letter types.

### Folders Code can use

The Code tab has its own folder list, **Settings → Folders Code can use** (`settings.code.roots`). It is separate from the terminal's list (`settings.terminal.roots`, §5): the terminal never reads Code's list, and Code never reads the terminal's (`apps/hub-api/src/lib/code-folders.ts`).

- A folder is checked when it is added (`POST /api/code/folders/resolve`, and again when Settings saves): no `..`, no system folder, no dotfile or dot-folder in your home folder, and no link that leads out of home. It is stored as its real path. The desktop app offers the native folder picker.
- Every saved folder is checked again each time Code uses it, so a folder later swapped for a link is skipped.
- On the first start after the split, a settings row with no `code` section gets a copy of the terminal's folders, once. Removing every Code folder stores an empty list, so they do not come back.
- `PUT /api/preferences` no longer accepts the `hub.settings` key. Settings are saved through `PATCH /api/settings`, which runs these checks.

### What the Changes view shows

The file **now**, against **before the run** plus the agent changes you accepted (`GET /api/code/versions`: `start`, `agent`, `original`, `current`; accepting stores the accepted text as a blob in the repository, `POST /api/code/accept-content`). So it always shows what is still worth looking at:

- **Green / red** with *Accept · Reject* — an agent change, exactly as the agent made it, not decided yet.
- **Blue** with *"Your edit" · Revert* — anything else that differs: lines you added, or an agent change you typed over (made here, in VS Code, or in the terminal — git cannot tell who typed, so anything that is not *exactly* the agent's is shown as yours). Your edits never need reviewing.
- Accepted changes and rejected ones **disappear from the diff**; a file with nothing left shows *Reviewed — edit freely* and is not folded.

Whether an agent change is decided is read from the **text itself**: type over it and it counts as edited; reject it and it is rejected; Ctrl+Z either, and it is pending again. Changes on neighbouring lines (or separated only by an empty line) are one change, so typing right next to an agent change makes the pair yours.

Progress shows as *"17 / 23 — 2 files left"* in the status bar, a ring per file, and a badge in the list with the changes left (`GET /api/code/progress`). The file bar counts the open file's changes, or says *Reviewed — edit freely*.

If something else writes the file while you have unsaved typing (VS Code, the terminal), **nothing is overwritten silently**: a bar offers *Keep mine (overwrite)* or *Use the version on disk*, and your text stays on screen until you choose. A file changed on disk while you have nothing unsaved simply reloads (it is read again every 10 seconds and when the window regains focus).

In a checkout (Local repositories) the same editor compares the file with the index: *Stage* (Alt+Y) stages that change exactly as shown, *Discard* (Alt+N) puts the staged lines back.

The editor has a shared theme picker with plot code panes (`components/code/ide-theme.tsx`). Built-in and Open VSX color themes persist in account settings; compatible Marketplace VSIX packages and JSON/JSONC color files can be imported locally. Imports read only bounded color data, never extension scripts; included files resolve within the package. Imported files stay on that browser/device and must be imported again on another device. Code is always in a coding font (Cascadia Code → Consolas, ligatures off) at its own size, whatever font and text size *Settings → Appearance* sets for the rest of Ensemble.

---

## 2. What a run is answerable for

Every run records **two snapshots** of its folder as git trees, using a throwaway index so your real staging area is never touched:

- **start** — the folder as the job found it: committed, staged, unstaged and never-added files alike;
- **end** — as the job left it.

Both are pinned as `refs/ensemble/review/<job>/{start,end}` for **14 days** (each tree in a commit of its own, `CodeReview.startCommit` and `endCommit`; `pinReviewSnapshots` in `lib/code-commit.ts`), so git's own garbage collection cannot take them; the daily sweep unpins them and marks the review expired (`runRetention`), which *Show expired* lists.

The review is start → end, so work you had **before** the run (your `plan.md`, your own edits) is never shown as the agent's. Source control lists it separately as *Your changes*, not ticked. Git-ignored files have no snapshot; if a run changed any, they are listed as *Changed, can't be reviewed*.

Runs from before snapshots existed are reviewed against the commit they started from, with a banner saying so.

### A failed or stopped run leaves nothing behind

When a run fails or you stop it (or reject its publishing), its folder is put back to the **start snapshot**. Only the files the agent itself changed are touched (each file-changing tool call is attributed); a file you changed meanwhile is left alone; and nothing is moved if the run had already committed. What it tried stays reviewable, with *Restore its changes* to put it back.

A **blocked** run (turn limit, needs information) keeps its work — *"progress is saved"* — and the next attempt continues from it and is reviewable like any other.

### Line endings

The host may have `core.autocrlf=true` in the system git config, which Ensemble's isolated git does not read. For the engineer's own folders Ensemble **reads that one setting the way their git sees it**, so CRLF working files are not mistaken for changes, snapshots store what their git would store, and a commit does not rewrite every line. The Code tab diffs LF text and every write puts the file's own line endings, BOM and final newline back.

---

## 3. Commit, push, pull request

*Source control* (`components/code/commit-panel.tsx`, `GET /api/code/commit-plan`) groups files exactly like the review: **changes from this run (ticked)** and **your changes (not ticked)**, so `plan.md` stays out unless you tick it. A subject with the 50/72 guide (the counter turns amber past 50 and red past 72; description lines over 72 are counted), a Markdown description with *Write | Preview*, and `Co-authored-by: Ensemble agent (<model>) <agent@ensemble.local>` when the run's files are included (a box turns it off). Committing the run's files while some of its changes are still undecided asks first. Drafts are kept per run on this device.

The commit is built from **exactly the ticked paths** (`POST /api/code/commit-paths`): in a throwaway index from HEAD, each ticked file stored as it is on disk (`hash-object --no-filters`, so no filter program of the repository runs), hooks never run, and HEAD moves only if it is still where it was. What you had staged otherwise stays staged. The author is *Settings → Terminal and commits → Commit author*, or your git config, or, on a computer where git has no identity, your Ensemble account's name and email.

*Push* runs `git push -u origin HEAD` with your computer's own git sign-in and the repository's hooks off, and asks before pushing straight to the default branch (origin's HEAD). The *Pull request* section (GitHub remotes) starts from the repository's template (`.github/pull_request_template.md` and the usual places) or the agent's report, with a base branch (the default one first) and *Draft*; it opens the pull request for the current branch through GitHub's API (`POST /api/code/pull-request`) with the GitHub sign-in Ensemble has: the git token saved in Settings, the GitHub connection, or `gh auth token`.

The rest of the panel is the repository's state: staged and unstaged files (stage, unstage, discard), recent commits, pull, and GitHub Actions runs for the branch.

---

## 4. Which branch the agent works on

The assign dialog's *Optional information* has *Which branch the agent works on*:

- **Use as is (default)** — nothing is created or switched. Your own folder is worked on exactly as it is; Ensemble's checkout uses the branch picked below or the default.
- **Existing branch** — Ensemble's checkout works directly on the branch you pick, for a pull request too (opened from that branch; **never the default branch**).
- **New branch** — create and switch to the name you give before starting. In your own folder that is `git switch -c`, carrying uncommitted work over.

---

## 5. The terminal — for you only

A small terminal docked under the editor, for the jobs that otherwise send you to a shell: make or switch a branch before assigning, install a package, run the tests, commit and push after reviewing. It opens in two places:

- **On the computer itself**, at Ensemble's own page on `localhost` (`routes/terminal.ts`). The desktop app's window cannot run a passkey check yet and says so.
- **On Ensemble on the web, for a paired computer** (14 Oct 2026): the Terminal button on that computer's card in the Code tab, or in a review of its code. Commands run on that computer, through Ensemble on the web (doc [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md) §4.7, `remote/terminal.ts`).

**It is not a shell:**

- **Who** — it needs a **passkey** (Touch ID, Windows Hello, a phone or a security key, with user verification) once per session: 30 minutes idle, 8 hours at most, *Lock now* any time. No agent, MCP call, API key, script or the assistant can produce one, and every terminal route refuses anything but a signed-in browser on Ensemble's own page. Adding a passkey needs the account password, or, on the web for an account that signs in with Google or GitHub, a code mailed to the account. On the web the passkey covers the terminal only; the review, editing and Source control work with your sign-in, and the computer's *Change code from the web* switch can turn those off.
- **What** — one program at a time from an allow-list, run by name, never through a shell: no pipes, redirects, `;`, `&&`, `$()` or backticks (`parseCommand`, `checkProgram` in `workspace/guard.ts`). `git` is hardened: the repository's hooks off, no fsmonitor, no `ext::` transports, `--force` refused in favour of `--force-with-lease`. Developer tools (`python`, `pip`, `uv`, `node`, `npm`, `pnpm`, `pytest`, `make`, `cargo`, `go` and similar), file tools (`ls`, `cat`, `grep`, `find`, `mkdir`, `cp`, `mv`, `rm` and similar) and `curl`/`wget`. Shell scripts run only as `sh script.sh` inside the sandbox, never `sh -c`. Never: `sudo`, `ssh`, `docker`, `osascript`, `open`, `launchctl`, `security`, `env`, `kill` and the rest of `NEVER`. Throwing away work (`git reset --hard`, `git clean`, `git restore`, `git checkout --`, deleting a branch, a forced push, `rm -r`) asks you to type `yes` first. Built in: `cd`, `pwd`, `clear`, `help`, `lock`.
- **Where** — Ensemble's workspace, the folders tasks ran in, and the folders you add in *Settings → Terminal and commits*; never above them, never a system or credential folder (`workspace/terminal-exec.ts`, shared by both terminals). Commands run under the computer's OS sandbox (macOS Seatbelt; bubblewrap or the Windows sandbox where set up): files change only inside the folder, home and app data are not readable. From the web, a computer without its sandbox set up refuses to run commands (`ensemble sandbox setup`). 15 minutes a command; the web shows up to 1 MB of output.
- **Record** — the computer's ledger records that a command ran (arguments, folder, exit code; `via: "web"` from the web); **never what it printed**. Ensemble on the web records the unlock and that a command ran on which computer, and keeps the output only while you read it (an hour at most, in Redis).

Settings can turn the terminal off on the computer (*Settings → Terminal and commits*), and *Terminal from the web* (Settings → this computer, or `ensemble web terminal off`) turns off only the web's.

### Passkeys and addresses

A passkey belongs to the **site it was made on** and stays on the device that made it (or your phone or key). On the computer's own page register at `http://localhost:<port>`, not `127.0.0.1`: browsers refuse passkeys on a raw IP. On the web it belongs to the web's own address (`app.ensemblework.com`), so one passkey opens the terminal on each of your paired computers. The fingerprint or PIN never reaches Ensemble; it only unlocks the passkey on that device.

---

## 6. Speed

- The list of reviews comes from the database, with each review's file and line counts from git (cached 8 s).
- A file's versions are read when its tab opens (`GET /api/code/versions`, one call for all four) and kept in the page's query cache; progress counts are cached per file until the file or its accepted text changes.
- CodeMirror, the merge view and each language parser load only on `/code/review`.
- Not built yet (designed earlier): the per-device IndexedDB cache of file versions, ETag revalidation, and prebuilt editor states for neighbouring files. Its Settings switch (*Keep reviewed code on this device*) was removed until it exists.

---

## 6a. In a space shared with you

Code is view only for anyone the space is shared with ([29](29_SHARING.md)): they can read reviews, files and diffs, but every `/api/code` write (accept, reject, edit, commit, push, discard) and the terminal are the owner's. A paired computer's code on the web is only ever its owner's, whichever space is open. The review page shows **View only** instead of the terminal and review actions, and the file editor is read-only. A single "code" share opens the list of reviews the same way.

## 7. Not in this version

- Side-by-side view and a change overview on the scrollbar (the unified view and the gutter cover the same ground).
- Autocomplete / IntelliSense, go-to-definition and formatting — this is a review-and-edit surface with syntax highlighting, brackets, indentation, multi-cursor and find/replace, **not a language server**.
- Files over **1 MB** are shown whole and read-only, with keep / put back.
- Terminal: an interactive shell, or programs that wait for typed input (one command at a time, no prompts); a separate broker process and Windows Job Objects.
- Web Worker diffing for very large runs.

---

## 8. Residual risks, said plainly

- **Native-mode agents run as you.** The terminal adds nothing they can reach, but the OS does not separate them from your account — sandbox mode is the real boundary.
- A process running as you could register a passkey before you do. Every registration is in the ledger and listed in Settings, so an unexpected one is visible and removable.
- Allowed programs are powerful by design: `git` follows repository config (hardened, not eliminated), and `npm install`, `make` or `pytest` run the repository's own code, inside the sandbox.
- **On the web, Ensemble's server passes the commands.** While you have the terminal unlocked, a compromised Ensemble on the web could send allow-listed commands to your computer, and it can always send Code calls (reading, and changing code unless you turned that off). Your computer still applies its own allow-list, folders, sandbox and switches; turn off *Terminal from the web* or *Change code from the web* there to rule them out.

Jump to searches **Local repositories** and **Code reviews** as section destinations (`/code#local-repositories`, `/code#reviews`), independently of repository or review names.
