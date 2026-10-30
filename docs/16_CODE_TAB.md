# 16 · The Code tab — review, rewrite, commit (and a guarded terminal)

The **Code** sidebar item opens Code's window on its **Welcome** tab: agent changes to review, recent repositories and recent code runs. A review or a repository opens in the same window as an IDE showing exactly what the agent changed, hunk by hunk: accept or reject each change, edit any file, see the whole file, commit, push, open a pull request, or run git in a small guarded terminal.

## Where Code runs

**On the computer** (desktop app or a local server), Code works on the folders in *Settings → Folders Code can use* and Ensemble's workspace through `/api/code/*`.

**On Ensemble on the web**, the server's own folders, repository operations and shell are operator-only (`lib/hosted-access.ts`); `/api/shell` reports this as `hostCode` (`canUseHostCredentials`, `routes/views.ts`). While it is false (`useHostCode` in `lib/use-module.ts`) the web makes no `/api/code/*` call: Code (`app/(hub)/code/page.tsx`) lists your computers; sidebar prefetch (`lib/prefetch.ts`), the repository lists in Settings and the Assign dialog (including `/api/workspace/*` checkouts and trusted folders) skip those reads; Today's *Reviews* tile points to Code. The API's `HOST_ACCESS_DENIED` is the fallback before the shell loads. The host terminal is off when `ENSEMBLE_TERMINAL=off`, and in hosted production unless `ENSEMBLE_TERMINAL=on`.

On the web the tab works on your paired computers (`lib/code-home.ts`). The Explorer has a section per computer (`components/code/computers-code.tsx`) with its **agent changes to review** and its **repositories** (its Code folders and Ensemble's workspace), read from that computer; the Welcome merges every computer's changes and repositories, naming the computer. Opening one gives the same review page as on the computer (`/code/review?device=<id>&review=<id>` or `&repo=<path>`), with Source control (stage, commit, push, pull, Actions), the IDE theme and the passkey-unlocked **Terminal** (§5). Each call is relayed to Ensemble on that computer ([25 §4.7](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#47-the-code-tab-and-terminal-on-the-web), `lib/code-target.tsx`):

- only from you, in your browser; never an API key, an agent or the assistant;
- never git's own files or secrets files; keys in code are hidden and a file holding one is read-only; files over 1 MB are read-only;
- the computer's switches decide what the web may do: *Show task files on the web* (reading), *Change code from the web* (every change), *Terminal from the web* (Settings → This computer, or `ensemble web`).

The computer must be online with CLI 0.3.8+ or desktop app 0.3.5+ (0.3.9+ / 0.3.6+ for the full editor); otherwise its Explorer section or the editor says what is missing. With no paired computer, the Welcome says so in one line and offers *Pair a computer*.

Failed review or repository queries show the error and Retry; they never claim there is no work. A denied terminal-status request shows an error, not "Opening the terminal…".

The task page's *Review changes* opens the same review. A repository the agent cloned is not a change; its edits inside one are.

**A run's files** (`components/code/run-code.tsx`, `/code?job=<id>&file=<path>`) open in a second tab of Code's window, read-only: the changed files (A, M or D with line counts) and *Folder on <computer>* on the left, the file read-only and highlighted (CodeMirror) on the right. On the desktop app and local servers a changed file opens from the copy the computer sent when the run ended (*as the run left it*); *Now* reads it again. **Ensemble on the web keeps no copy** (`keepsRunFileText` in `lib/hosted-access.ts`, [25 §4.6](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#46-a-tasks-files-on-the-web)): every file is read from the computer when opened, so it must be online. The folder is read one folder or file at a time under the rules in [25 §4.6](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#46-a-tasks-files-on-the-web); only the person whose computer ran the task sees file text. It needs CLI 0.3.7+ or desktop app 0.3.4+ and *Show task files on the web* (`ensemble browse on`). Full screen fills the window (Esc leaves). The run preview's *Files*, the task's *Agent output* and a run on a computer in the Welcome's *Recent agent runs* link here.

---

## 1. Using it

### The window

`/code` (`components/code/code-home.tsx`) and a review or repository (`/code/review`, `components/code/ide.tsx`) are the same window, built from `components/code/ide-chrome.tsx` and themed by `ide-theme.tsx`; it fills the main area.

- **Activity bar**: *Welcome* (Home), *Explorer*, *Search* (*Find in files* in a repository), *Source control* (*Changes to review* on the Welcome, with a count) and, at its foot, *Terminal*. In a review or repository the Explorer's *Changes from this run* (*Changes*), *Changed, can't be reviewed* and *Folder* sections fold like VS Code's (`Fold` in `components/code/code-lists.tsx`); what is folded is kept in `ensemble.code.folds`.
- **Side panel**: drag its edge, 200 px to half the window; double-click resets (260 px); arrow keys move it 16 px (48 with Shift) when it has focus. Ctrl+B shows or hides it.
- **Terminal panel** under the editor: drag its top edge, 140 px to three quarters of the window; double-click resets (280 px); arrow keys as above. Ctrl+` shows or hides it. On the web it is the selected computer's terminal (§5).
- **Status bar**: on the Welcome the computer with an online dot (a menu when there are several), Ensemble's version there, changes to review, code runs working now and the code size; in a review, the items in the next paragraph.

Panel sizes, which panels are open, the selected computer and the theme are kept in this browser (`ensemble.code.*`). Below 768 px the side panel is an overlay (below).

### The Welcome

- **Start**: *Open a repository…* (opens the Explorer and its *Find a repository* box), *Review agent changes*, *Open terminal*, and *Folders Code can use* (on the web, *Your computers*).
- **Needs review**: agent changes not yet reviewed, newest first: task, repository, branch, files, model, when, lines added and removed. Six show; *View all* lists the rest in place.
- **Recent repositories**: up to eight, most recently used first, with branch and (on the web) computer.
- **Recent agent runs**: the last five code runs with their state, repository and computer, opening the run (`/runs?run=<id>`).

*Changes to review* in the side panel filters *To review*, *Reviewed* or *All*; on the computer it can also *Show expired*. `/code#reviews` opens it and `/code#local-repositories` opens the Explorer.

### Repository names

`GET /api/code/repos` answers `repos` (paths, for older clients and paired computers) and `details`: per path its `name`, `kind` (`folder`, `workspace` or `run`), `remote` (origin as `owner/repo` or a local folder's name, never the URL), `branch`, `taskTitle` and `at` (last use). They are read from git's own files without running git (`repoLabelInfo` in `lib/git.ts`). A run's checkout (`<workspace>/runs/<job id>`) is named by the task that made it, else its origin, else *Run checkout*, with the muted note *run checkout*; a folder keeps its folder name, with its origin when that differs. A computer that sends no `details` is named from the path (`lib/code-repos.ts`): a folder named by an id is a *Run checkout*. Run checkouts that look alike (same name, origin and branch) fold into one row marked ×n that opens the newest, and branch parts that are ids show as `…`. The Explorer folds run checkouts under *Run checkouts*; the Welcome lists one only when it was used within the review window (14 days) and has a task or an origin.

### The review

The review is an IDE (`components/code/ide.tsx`): the window above with the run's or repository's Explorer, *Find in files*, Source control, file tabs, the editor and a status bar (branch with ahead/behind, review progress, computer, line and column, language, line endings, save state, code size). The editor is CodeMirror's merge view (`components/code/review-editor.tsx`, `@codemirror/merge`).

| You want to… | Do this |
|---|---|
| See what a run changed | Code → *Needs review* (or *Review changes* on the task page or its run) |
| Keep an agent change | *Accept*, or Alt+Y with the cursor in it. Nothing on disk changes |
| Undo an agent change | *Reject*, or Alt+N. The old lines go back on disk; Ctrl+Z brings the change back |
| Change something yourself | Type, in either view. Your edits show in **blue** with *Revert* (Alt+N) |
| Put a file back as the run left it | *Restore the run's version* in the file bar (drops your edits and rejects in that file) |
| Read or edit the whole file | *File*, or F4: folding and change bars, same document as Changes. A file with nothing to review opens whole |
| Open any file | The explorer's *Folder* tree, or *Go to file* (tracked and new files) |
| Find text in the files | *Find in files* (fixed text, optional match case, up to 500 results) |
| Move around | F7 / Shift+F7 next/previous change (past the last, the next file); Alt+→ / Alt+← next/previous changed file |
| Find / replace in the file | Ctrl+F |
| Focus | Full screen (Esc leaves), Ctrl+B explorer, `?` shortcuts (outside the editor) |
| Resize the explorer or the terminal | Drag the edge (§1 *The window*; double-click resets; arrow keys when focused) |
| Code text size | Status bar size, or Ctrl+Shift+= / - / 0 (10–24 px, editor and terminal only) |
| Commit / push | *Source control* |
| Run git yourself | The terminal button, or Ctrl+` |

**At most 10 files are open** (`MAX_OPEN_FILES` in `lib/code-tabs.ts`). Opening one more closes the oldest open file that has nothing unsaved and is not in view; when every other open file still has an edit being saved, the new one is refused with that reason. A closed file's text is dropped from the browser's memory once it is saved (an edit that failed to save stays until it does). On the web a file over 1 MB opens read-only (`CODE_EDIT_BYTES`), and an answer over 3 MB (`CODE_ANSWER_BYTES`, a file and its versions together) is not shown: open it on the computer. Files and edits pass through Ensemble on the web without being stored: each call is relayed through Redis, held in memory only until it is answered or its time limit passes, then deleted (`devices/file-relay.ts`). Web terminal output is held there for up to an hour so the page can catch up (`RUN_TTL_SECONDS` in `devices/code-routes.ts`). The hosted Redis writes nothing to disk (`--save "" --appendonly no`, `infra/deploy/home/compose.yml`). Nothing about your code is written to the browser's storage either; only the editor's theme, sizes and panels are remembered.

It is an **editor first**. Typing in either view saves automatically: 0.7 s after you stop, on Ctrl+S, when you switch file or view, and before a commit or push. The status bar and tab show `• Unsaved` → `Saving…` → `Saved`. A save names the version the editor read (`expectedHash`), so nothing is overwritten if the file changed meanwhile (below). The editor works on LF text; saves restore the file's own line endings and byte-order mark (`lib/code-versions.ts`). No shortcut is a bare letter or an editing key.

On the computer, binary files are not shown and files over 5 MB are not opened.

Below 768 CSS pixels Code's window starts with its side panel closed and the Welcome is one column. The side panel opens as a bounded overlay; choosing a file or tapping outside closes it. This does not change the desktop panel preference. The read-only run browser has a Files / Show code switch instead of squeezing the file list and editor side by side. Editor toolbars and code keep their own horizontal scrolling.

### Folders Code can use

*Settings → Folders Code can use* (`settings.code.roots`) is separate from the terminal's list (`settings.terminal.roots`, §5); neither reads the other (`apps/hub-api/src/lib/code-folders.ts`).

- A folder is checked when added (`POST /api/code/folders/resolve`, and again when Settings saves): no `..`, no system folder, no dotfile or dot-folder in your home folder, no link leading out of home. It is stored as its real path. The desktop app's native picker goes through the Tauri dialog plugin (`lib/desktop-dialog.ts`).
- Every saved folder is checked again on each use, so a folder later swapped for a link is skipped.
- At startup, a settings row with no `code` section gets a copy of the terminal's folders once; removing every Code folder stores an empty list.
- Settings are saved through `PATCH /api/settings`, which runs these checks; `PUT /api/preferences` refuses the `hub.settings` key.

### What the Changes view shows

The file **now** against **before the run** plus the agent changes you accepted (`GET /api/code/versions`: `start`, `agent`, `original`, `current`; accepting stores the accepted text as a blob in the repository, `POST /api/code/accept-content`):

- **Green / red** with *Accept · Reject*: an agent change, exactly as the agent made it, not yet decided.
- **Blue** with *Your edit · Revert*: anything else that differs, including an agent change you typed over (here, in another editor or in the terminal; git cannot tell who typed). Your edits never need review.
- Accepted and rejected changes leave the diff; a file with nothing left shows *Reviewed — edit freely*.

Whether a change is decided is read from the **text**: type over it and it is yours, reject it and it is rejected, Ctrl+Z either and it is pending again. Changes on neighbouring lines (or separated only by an empty line) count as one.

Progress shows as *"17 / 23 — 2 files left"* in the status bar, a ring per file and a badge in the list (`GET /api/code/progress`).

If another program writes the file while you have unsaved typing, **nothing is overwritten silently**: a bar offers *Keep mine (overwrite)* or *Use the version on disk*, and your text stays until you choose. With nothing unsaved the file simply reloads (it is reread every 10 seconds and when the window regains focus).

In a repository opened from the Explorer the same editor compares with the index: *Stage* (Alt+Y) stages that change as shown, *Discard* (Alt+N) puts the staged lines back.

The theme picker (`components/code/ide-theme.tsx`, shared with plot code panes) saves built-in and Open VSX color themes in account settings; Marketplace VSIX packages and JSON/JSONC color files import into that browser only, reading bounded color data and never extension scripts. Code always uses a coding font (Cascadia Code → Consolas, ligatures off) at its own size.

---

## 2. What a run is answerable for

Each code run records **two snapshots** of its folder as git trees, using a throwaway index so your staging area is untouched:

- **start**: the folder as the job found it, including staged, unstaged and never-added files;
- **end**: as the job left it.

Both are pinned as `refs/ensemble/review/<job>/{start,end}` for **14 days** (each in its own commit, `CodeReview.startCommit` and `endCommit`; `pinReviewSnapshots` in `lib/code-commit.ts`) so git's garbage collection cannot remove them. The daily retention pass then unpins them and marks the review expired (`runRetention`); *Show expired* lists those.

A run that writes in a repository its folder's snapshot does not cover (another folder it was allowed to write, or a repository nested in a folder that is not one) snapshots that repository at its first write there; its changes are listed with the run's files, and when the run folder itself has none the review is of that repository ([25 §4.6](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#46-a-tasks-files-on-the-web)). Code opens a review's repository even outside *Folders Code can use*: Ensemble recorded it.

The review is start → end, so work you had before the run is never shown as the agent's; Source control lists it as *Your changes*, unticked. Git-ignored files have no snapshot; changed ones are listed as *Changed, can't be reviewed*. Failed and stopped runs get a review too, and their changes stay in the folder until you decide.

*Accept all* (`POST /api/code/reviews/:id/accept`) keeps what is on disk; in Ensemble's checkout it commits the agent's files on the run's branch with hooks off, while an outside folder is left uncommitted. Only the run's files git still sees are staged (on disk, or tracked and so staged as a deletion); one that is gone, such as a file the run removed again or that was committed and moved since, is skipped instead of failing the commit. *Discard all* (`POST /api/code/reviews/:id/discard`) puts the agent's files back as the run found them; the agent's commits are undone only in Ensemble's checkout, otherwise kept and reported, and an agent-owned task waiting for approval or done returns to Todo. *Push* on a reviewed run pushes the run's branch to its `origin` without force, with the computer's sign-in (`git push -u origin HEAD`).

---

## 3. Commit, push, pull request

*Source control* (`components/code/commit-panel.tsx`, `GET /api/code/commit-plan`) groups files like the review: **changes from this run (ticked)** and **your changes (unticked)**. The subject follows the 50/72 guide (counter amber past 50, red past 72; description lines over 72 counted), the description is Markdown with *Write | Preview*, and `Co-authored-by: Ensemble agent (<model>) <agent@ensemble.local>` is added when the run's files are included (a box turns it off). Committing run files with undecided changes asks first. Drafts are kept per run on this device.

The commit is built from **exactly the ticked paths** (`POST /api/code/commit-paths`): a throwaway index from HEAD, each file stored as on disk (`hash-object --no-filters`, so no repository filter runs), hooks never run, and HEAD moves only if it has not moved. Other staged work stays staged. The author is *Settings → Terminal and commits → Commit author*, else your git config, else your Ensemble account's name and email.

*Push* runs `git push -u origin HEAD` with the computer's own git sign-in and hooks off, and asks before pushing to the default branch (origin's HEAD). *Pull request* (GitHub remotes) starts from the repository's template (`.github/pull_request_template.md` and the usual places) or the agent's report, with a base branch and *Draft*, and opens it through GitHub's API (`POST /api/code/pull-request`) using the git token in Settings, the GitHub connection, or `gh auth token`.

The rest of the panel shows staged and unstaged files (stage, unstage, discard), recent commits, pull, and GitHub Actions runs for the branch.

---

## 4. Which branch the agent works on

The Assign dialog's *Optional information* has *Which branch the agent works on*:

- **Use as is (default)**: nothing is created or switched. Your own folder is used as it is; Ensemble's checkout stays on the branch it was cloned on.
- **Existing branch**: the run switches to that branch, any branch, fetching it when it is only on the remote.
- **New branch**: `git switch -c <exact name>` before starting, in Ensemble's checkout or your own folder (uncommitted work carries over); an existing branch of that name is switched to.

---

## 5. The terminal — for you only

A terminal panel under the editor (resizable, §1) for what would otherwise send you to a shell: make or switch a branch, install a package, run tests, commit and push. It opens:

- **on the computer itself**, at Ensemble's page on `localhost` (`routes/terminal.ts`). The desktop app's window shows a note instead, because its webview cannot run the passkey check (`components/code/terminal-desktop-note.tsx`);
- **on Ensemble on the web, for a paired computer**: the Terminal button on its Explorer section in Code, *Terminal* with that computer selected, or in a review of its code. Commands run on that computer through the relay ([25 §4.7](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#47-the-code-tab-and-terminal-on-the-web), `remote/terminal.ts`).

**It is not a shell:**

- **Who**: a **passkey** with user verification (Touch ID, Windows Hello, a phone or a security key) once per session: 30 minutes idle, 8 hours at most, *Lock now* any time. No agent, MCP call, API key, script or the assistant can produce one, and every terminal route refuses anything but a signed-in browser on Ensemble's own page. Adding a passkey needs the account password, or on the web, for an account that signs in with Google or GitHub, a code mailed to the account. On the web the passkey covers only the terminal; review, editing and Source control use your sign-in and the computer's *Change code from the web* switch. A locked terminal (*Lock now*, `lock`, or expiry) refuses commands with `423` and code `TERMINAL_LOCKED` (`lib/terminal-human.ts`), never `401`, so you stay signed in and the panel returns to its unlock button.
- **What**: one allow-listed program at a time, run by name, never through a shell: no pipes, redirects, `;`, `&&`, `$()` or backticks (`parseCommand`, `checkProgram` in `workspace/guard.ts`). `git` is hardened: hooks off, no fsmonitor, no `ext::` transports, `--force` refused in favour of `--force-with-lease`. Developer tools (`python`, `pip`, `uv`, `node`, `npm`, `pnpm`, `pytest`, `make`, `cargo`, `go` and similar), file tools (`ls`, `cat`, `grep`, `find`, `mkdir`, `cp`, `mv`, `rm` and similar) and `curl`/`wget`. Shell scripts run only as `sh script.sh` inside the sandbox, never `sh -c`. Never: `sudo`, `ssh`, `docker`, `osascript`, `open`, `launchctl`, `security`, `env`, `kill` and the rest of `NEVER`. Destructive commands (`git reset --hard`, `git clean`, `git restore`, `git checkout --`, deleting a branch, a forced push, `rm -r`) need you to type `yes`. Built in: `cd`, `pwd`, `clear`, `help`, `lock`.
- **Where**: Ensemble's workspace, folders tasks ran in, and folders added in *Settings → Terminal and commits*; never above them, never a system or credential folder (`workspace/terminal-exec.ts`, shared by both terminals). Commands run under the computer's OS sandbox ([24](24_DESKTOP_SANDBOXING.md)): files change only inside the folder; home and app data are unreadable. From the web, a computer without a working sandbox refuses commands (`ensemble sandbox setup`). 15 minutes per command; the web shows up to 1 MB of output.
- **Record**: the computer's ledger records that a command ran (arguments, folder, exit code; `via: "web"` from the web), **never its output**. Ensemble on the web records the unlock and which computer ran a command, and keeps output only while you read it (an hour at most, in Redis).

*Settings → Terminal and commits* can turn the terminal off on the computer; *Terminal from the web* (Settings → This computer, or `ensemble web terminal off`) turns off only the web's.

### Passkeys and addresses

A passkey belongs to the **site it was made on** and stays on the device that made it (or your phone or key). On the computer's own page register at `http://localhost:<port>`, not `127.0.0.1`: browsers refuse passkeys on a raw IP. On the web it belongs to the web's address (`app.ensemblework.com`), so one passkey opens the terminal on each paired computer. The fingerprint or PIN never reaches Ensemble.

On the web, Settings shows **Unlock to manage passkeys**, which runs the same check as the terminal; removing a passkey needs an unlocked session. The buttons stay visible for touch and keyboard users.

---

## 6. Speed

- The review list comes from the database, with each review's file and line counts from git (cached 8 s).
- A file's four versions load in one call when its tab opens (`GET /api/code/versions`) and stay in the page's query cache; progress counts are cached per file until the file or its accepted text changes.
- CodeMirror, the merge view and language parsers load only on `/code/review`.

## 7. In a space shared with you

Code is view only for people a space is shared with ([29](29_SHARING.md)): they read reviews, files and diffs, but every `/api/code` write (accept, reject, edit, commit, push, discard) and the terminal stay with the owner. A paired computer's code on the web is only ever its owner's, whichever space is open. Code's window shows **View only** instead of the terminal and review actions, and the editor is read-only. A single "code" share opens the review list the same way.

The **Search and jump** dialog offers **Local repositories** and **Code reviews** as destinations (`/code#local-repositories` opens the Explorer, `/code#reviews` the *Changes to review* panel).

## 8. Limits and residual risks

- Not supported: side-by-side view, a change overview on the scrollbar, autocomplete, go-to-definition, formatting (it is a review-and-edit surface with highlighting, brackets, indentation, multi-cursor and find/replace, **not a language server**), an interactive shell or programs that wait for typed input, and diffing in a Web Worker.
- **Agents with the sandbox off run as you.** The terminal adds nothing they can reach, but only the OS sandbox separates them from your account.
- A process running as you could register a passkey first. Every registration is in the ledger and listed in Settings, so an unexpected one is visible and removable.
- Allowed programs are powerful by design: `git` follows repository config (hardened, not eliminated), and `npm install`, `make` or `pytest` run the repository's code, inside the sandbox.
- **On the web, Ensemble's server relays the commands.** While the terminal is unlocked, a compromised Ensemble on the web could send allow-listed commands to your computer, and it can always send Code calls (reading, and changing code unless turned off). The computer still applies its allow-list, folders, sandbox and switches; turn off *Terminal from the web* or *Change code from the web* there to rule them out.
