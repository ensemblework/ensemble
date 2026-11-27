# 16 · The Code tab: review, rewrite, commit, code with an agent and a guarded terminal

Open **Code** in the sidebar, then **Open a folder** or a recent repository from **Welcome**. Review each change, edit files and use Source control to commit or push. Switch the window to **Agent** to work with your own coding agent in the same folder (§9). The guarded terminal lets you run supported commands on the selected computer.

## 1. Using it

### The window

`/code` (`components/code/code-home.tsx`) and a review or repository (`/code/review`, `components/code/ide.tsx`) are the same window, built from `components/code/ide-chrome.tsx` and themed by `ide-theme.tsx`; it fills the main area.

An editor theme colours the surfaces, text and status colours, never the accent: icons, the active tab and selections keep the accent picked in Settings › Appearance, adjusted for the theme's light or dark surfaces.

**Editor | Agent.** Code's window, on the Welcome and in a repository or review, has one switch between the editor and the agent (§9). Ctrl+Alt+I, the *Agent* item on the activity bar, or *Code with the agent* in the command palette switches too. The agent's sessions take the side panel while the agent shows, and the explorer comes back with the editor; the activity bar, terminal and status bar stay as they are. Opening a file from the explorer, quick open or a thread shows the editor. The choice is kept in this browser (`ensemble.code.view`), and `?view=agent` or `?view=editor` in the address picks one.

#### Activity bar

*Agent*, *Explorer*, *Search* (in a repository: *Find in files*), *Source control* (*Changes to review* on the Welcome, with a count) and, at its foot, *Terminal*. There is no Home item: the Welcome is its own tab, and a repository's window goes back to it with the arrow in its title bar.

**One computer at a time.** On the Welcome the side panel starts with the computer Code shows (`components/code/machine-switcher.tsx`): its name and an online dot. Opening it reads every paired computer's state again and lists them, online or when last seen; picking one shows its repositories, changes to review, threads and runs only (`useCodeHome(preferred)` in `lib/code-home.ts` reads only that computer). The choice is kept in this browser (`ensemble.code.computer`); a computer that is gone or unreadable gives way to the first that answers. With this computer's own Ensemble there is one, shown as a label.

In a review or repository the Explorer's *Changes from this run* (*Changes*), *Changed, can't be reviewed* and folder sections fold like VS Code's (`Fold` in `components/code/code-lists.tsx`); the folder's section is named after the repository, and what is folded is kept in `ensemble.code.folds`. Every side panel starts with a heading row; rows are 22 px, as in VS Code.
- **Side panel**: drag its edge, 200 px to 40% of the window; double-click resets (260 px); arrow keys move it 16 px (48 with Shift) when it has focus. Dragging never closes it; Ctrl/⌘+B shows or hides it. The agent's sessions take at most 30% of the window and at least what their names need (`sessionsMinWidth`: 200 to 320 px for names up to 30 characters).
- **Terminal panel** under the editor: drag its top edge, 140 px to three quarters of the window; double-click resets (280 px); arrow keys as above. Ctrl+` shows or hides it. On the web it is the selected computer's terminal (§5).
#### Status bar

it starts with the computer, as VS Code's remote indicator: its name and an online dot, tinted while it cannot be reached.

On the Welcome it opens the side panel's computer, followed by Ensemble's version there, changes to review, code runs working now and the text size; in a review it opens a menu with the folder's path, *Copy the folder's path*, *Open the terminal here* and *Back to Code*, followed by the items in the next paragraph.
- **Quick open** (`components/code/quick-open.tsx`, matching in `lib/code-quick-open.ts`): one box at the top of the window, as VS Code's. Ctrl/⌘+P (or the Explorer's *Go to file*) finds a file by fuzzy name, the files opened last first, with Enter going back to the one before; `name.ts:12` opens it at line 12. `>`, Ctrl/⌘+Shift+P or F1 lists the window's commands with their keys (view, save, close, next change, reveal, copy paths, *Ask Ensemble* about the file or selection, new file or folder, Accept all, Discard all, push, colour theme, text size, full screen). `:` or Ctrl+G goes to a line. On the Welcome, Ctrl/⌘+P lists every repository by name and `>` the Welcome's commands. Ctrl/⌘+O opens a folder (below), in either window. Shortcuts are written as the platform writes them (⇧⌘P on a Mac, Ctrl+Shift+P elsewhere).

Panel sizes, which panels are open, the selected computer and the theme are kept in this browser (`ensemble.code.*`). Below 768 px the side panel is an overlay (below).

### New files and folders

1. Select the destination folder in Explorer. If you do not select one, Code uses the open file’s folder.
2. Choose **New file** or **New folder** from the folder heading or command palette. The heading also offers Refresh, Collapse folders and Download.
3. Type the name in place. Press Enter to create it or Esc to cancel; there is no extra confirmation. A path (`lib/util/new.ts`) makes the folders on the way too. A full path (`/…` or `~/…`) makes it elsewhere, only inside the workspace or a folder Code can use; paths outside the repository are never listed, only typed. Nothing already there is overwritten. A new file opens in the editor. `POST /api/code/create` (`createRepoEntry`, `createInRoots` in `lib/git.ts`); a paired computer answers it from Code API 4 (an older one makes files in folders that exist, not folders).

### Explorer, tabs and the editor, as in VS Code

#### Marks

every file in the explorer, the Changes list, Go to file, the tabs and the path bar has its language mark (TypeScript, React, Python, Java, Go, Rust, Markdown, JSON, YAML, images, lockfiles, Dockerfile, package.json, next.config and about seventy more), and the status bar names its language (`lib/file-kinds.ts`, `components/code/file-icon.tsx`). A file the run or you changed is coloured by its git status, with the letter at the right.
#### Move and rename

drag a file or folder onto a folder (or the folder section's empty space for the top) to move it; holding over a closed folder opens it. F2, or *Rename*, renames in place (the name without its extension is picked). Nothing already there is overwritten, a folder cannot go into itself, and open tabs follow what moved. `POST /api/code/move` (`moveRepoEntry`).
#### Right-click

a file has Open, Open preview, Ask Ensemble ▸ (Explain, Find bugs, Suggest improvements, Write tests, Doc comments), Attach file to assistant, New task about this file, Copy path / relative path / name, Rename, Delete (asked in the menu) and Download; a folder has New file, New folder, the copies, Rename, Delete and Download as zip; the empty space has New file/folder, Refresh, Collapse and Download repository as zip. A tab has Close, Close others, Close to the right, Close all, the copies, Reveal in explorer and Download.

In the editor it has Ask and Attach for the selection (or the file), New task from selection, Cut · Copy · Paste, Copy path with line, Reveal in explorer and Download. `components/code/code-menus.ts`. `POST /api/code/delete` (`deleteRepoEntry`).
#### Download

a file, or a folder or the whole repository as a zip of what git would show (tracked and new files, not ignored ones, never files of keys or secrets), up to 20 MB; more is refused rather than cut short. `GET /api/code/download` (`packRepoEntry`), base64 in JSON so a paired computer answers the same way (Code API 5, CLI 0.6.9 and later; its answers are capped at 3 MB).

An older CLI on that computer answers moving, deleting and downloading with "Update Ensemble on …".
- **Preview**: only Markdown, HTML, SVG and CSV/TSV have a **Preview** button beside Changes and File (Ctrl+Shift+V): Markdown as a page, HTML in a frame with no scripts, SVG as a picture and tables as a grid. An image opens as the picture itself, on a checkerboard with its size.
#### Tabs

the whole tab opens its file; a middle click or Alt+W closes it (Ctrl/⌘+W in the desktop app, where the browser does not keep it); the close button shows on hover and on the file in view, and an unsaved file shows a dot that turns into the close button on hover. Two open files with one name show their folder.

The strip scrolls sideways with the wheel and keeps the file in view on screen; when the tabs do not fit, an arrow at each end shows the next hidden tab, one per click (`ScrollTabs` in `ide-chrome.tsx`, also on Code's home); Alt+1…8 opens the first to eighth tab, Alt+9 the last, Ctrl+PageDown / PageUp the next or previous, and arrow keys move between focused tabs.
- **Breadcrumbs** above the editor: each folder, and the file, shows itself in the Explorer.
- **Nothing open**: the editor shows what to do next with its keys (*Show all commands*, *Go to file*, *Find in files*, the terminal, the side panel). The first changed file opens by itself once; closing every file leaves the editor empty.

### The Welcome

The computer's name, then two ways to start and two short lists, one line per row. Everything longer is in the side panel and in Runs.

- **Open a folder** (Ctrl/⌘+O, the folder picker below) and **Code with an agent** (the agent's view, no repository needed; §9).
- **Recent**: up to five repositories, most recently used first, with their branch; *All* opens the Explorer.
- **To review**: agent changes not yet reviewed, newest first, with their repository; it shows only when there are any. Three show; *All* opens *Changes to review*.

### Open a folder

The folder picker (`components/code/folder-picker.tsx`) is drawn like a computer's own Open panel: places on the left (*Home*, *Desktop*, *Documents*, the project folders that are there (`code`, `Projects`, `dev`, `src`, `repos`…), the *Ensemble workspace* and the folders Code can use), the folders of the one open on the right with git repositories marked, a path to step back along, a filter, and **New folder** (a git repository in it unless *Git* is cleared). It browses the computer Code shows through its Code API (`GET /api/code/browse`, `lib/code-browse.ts`), never this browser's own disk, which is often another machine. Only those places are listed: never `/`, system folders, other accounts, dot-folders in the home folder or app data; dependency and build folders (`node_modules`, `dist`…) are left out. The home folder, Desktop and Documents can be looked through but are too broad to open.

A folder outside the workspace and the folders Code can use is trusted once before it opens: *Trust and open* adds it to the folders Code can use on that computer (`POST /api/code/folders/trust`, the same checks as Settings; ledger `code.folder_trust`). A folder that is not a git repository offers *Start a git repository in it*. The agent's place bar opens the same picker (§9). A computer before Ensemble 0.8.3 says to update it and lists the repositories it knows instead; its branch menu shows the branch without switching or making one.

Assign → **Where it works** and Settings → Agents → **Run profiles** reuse this component and its globally loaded `folder-picker.css`, browsing the selected computer rather than the browser's disk. For paired task runs they always ask first (*Share and choose*, even for a folder Code can already use), then send `share: true` to the same trust route (Code API 7): it returns the shared `label` and resolved `path`, retaining an existing folder's share or sharing a new one with read-write access, marked as made from the web so it takes runs only while *Change code from the web* is on there ([25 §4.4](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#44-web-ui)). The relay updates the computer's published folders before answering, so the folder is assignable immediately. A computer without this operation says to update it; it never pretends a folder was shared. [06 §1](06_MODULE_WORKSPACE_AND_SURFACES.md#1-assigning) describes the saved place.

*Changes to review* in the side panel filters *To review*, *Reviewed* or *All*; on the computer it can also *Show expired*. `/code#reviews` opens it and `/code#local-repositories` opens the Explorer.

### Repository names

`GET /api/code/repos` answers `repos` (paths, for older clients and paired computers) and `details`: per path its `name`, `kind` (`folder`, `workspace` or `run`), `remote` (origin as `owner/repo` or a local folder's name, never the URL), `branch`, `taskTitle` and `at` (last use).

They are read from git's own files without running git (`repoLabelInfo` in `lib/git.ts`). A run's checkout (`<workspace>/runs/<slug>`, named by the run's model, or from its title for a chat turn; [06 §2](06_MODULE_WORKSPACE_AND_SURFACES.md#2-context-and-preparation)) is named by the task that made it, else its origin, else *Run checkout*, with the muted note *run checkout*; a folder keeps its folder name, with its origin when that differs. A computer that sends no `details` is named from the path (`lib/code-repos.ts`): a folder named by an id is a *Run checkout*.

Run checkouts that look alike (same name, origin and branch) fold into one row marked ×n that opens the newest, and branch parts that are ids show as `…`.

The Explorer folds run checkouts under *Agent worktrees* (closed until opened, remembered): each row shows the task, its branch and how long ago it was used; the Welcome lists one only when it was used within the review window (14 days) and has a task or an origin.

### The review

The review is an IDE (`components/code/ide.tsx`): the window above with the run's or repository's Explorer, *Find in files*, Source control, file tabs, the editor and a status bar (computer, branch with ahead/behind, review progress, line and column (opens *Go to line*), language, line endings, save state, code size).

While this browser or the computer is offline a one-line notice says so under the tabs. The editor is CodeMirror's merge view (`components/code/review-editor.tsx`, `@codemirror/merge`). While a folder opens, its window frame and explorer geometry stay in place.

Opening a folder or file and searching within files show a local progress strip only after the shared loading delay (`IdeProgress`); cached reads paint without it.

| You want to… | Do this |
|---|---|
| See what a run changed | Code → *To review* (or *Review changes* on the task page or its run) |
| Keep an agent change | *Accept*, or Alt+Y with the cursor in it. Nothing on disk changes |
| Undo an agent change | *Reject*, or Alt+N. The old lines go back on disk; Ctrl+Z brings the change back |
| Change something yourself | Type, in either view. Your edits show in **blue** with *Revert* (Alt+N) |
| Put a file back as the run left it | *Restore the run's version* in the file bar (drops your edits and rejects in that file) |
| Read or edit the whole file | *File*, or F4: folding and change bars, same document as Changes. A file with nothing to review opens whole |
| Open any file | The explorer's folder tree, or Ctrl/⌘+P *Go to file* (tracked and new files) |
| Run any command | Ctrl/⌘+Shift+P or F1 |
| Go to a line | Ctrl+G, or the status bar's line and column |
| Find text in the files | *Find in files*, or Ctrl/⌘+Shift+F with the selection (fixed text, optional match case, up to 500 results, grouped by file with the match marked) |
| Move around | F7 / Shift+F7 next/previous change (past the last, the next file); Alt+→ / Alt+← next/previous changed file |
| Find / replace in the file | Ctrl+F |
| Focus | Full screen (the browser's own, as F11; Esc leaves), Ctrl/⌘+B side panel, Ctrl/⌘+Shift+E Explorer, Ctrl+Shift+G Source control, `?` shortcuts (outside the editor) |
| Resize the explorer or the terminal | Drag the edge (§1 *The window*; double-click resets; arrow keys when focused) |
| Text size | Status bar size, or Ctrl+Shift+= / - / 0 (10 to 24 px): the editor and terminal at that size, the agent's thread and the Welcome scaled with it (`textScale`) |
| Switch or start a branch | The branch in the status bar (in a repository): the branch checked out, the others newest first (found by name when there are many) and *New branch from* the one checked out (`GET`/`POST /api/code/branches`, `POST /api/code/branches/switch`; git's own `switch`, so changes it would overwrite stop it) |
| Commit / push | *Source control* |
| Run git yourself | The terminal button, or Ctrl+` |

**At most 10 files are open** (`MAX_OPEN_FILES` in `lib/code-tabs.ts`). Opening one more closes the oldest open file that has nothing unsaved and is not in view; when every other open file still has an edit being saved, the new one is refused with that reason. A closed file's text is dropped from the browser's memory once it is saved (an edit that failed to save stays until it does).

On the web a file over 1 MB opens read-only (`CODE_EDIT_BYTES`), and an answer over 3 MB (`CODE_ANSWER_BYTES`, a file and its versions together) is not shown: open it on the computer. Files and edits pass through Ensemble on the web without being stored: each call is relayed through Redis, held in memory only until it is answered or its time limit passes, then deleted (`devices/file-relay.ts`).

Web terminal output is held there for up to an hour so the page can catch up (`RUN_TTL_SECONDS` in `devices/code-routes.ts`). The hosted Redis writes nothing to disk (`--save "" --appendonly no`, `infra/deploy/home/compose.yml`). Nothing about your code is written to the browser's storage either; only the editor's theme, sizes and panels are remembered.

It is an **editor first**. Typing in either view saves automatically: 0.7 s after you stop, on Ctrl/⌘+S, when you switch file or view, and before a commit or push. The status bar and tab show `• Unsaved` → `Saving…` → `Saved`.

While this browser or the computer is offline nothing is sent: the edit stays on the page as `• Unsaved, offline` and is saved when both are back (a computer's state is read again every 30 s). A save names the version the editor read (`expectedHash`), so nothing is overwritten if the file changed meanwhile (below).

The editor works on LF text; saves restore the file's own line endings and byte-order mark (`lib/code-versions.ts`). No shortcut is a bare letter or an editing key.

On the computer, binary files are not shown and files over 5 MB are not opened.

Below 768 CSS pixels Code's window starts with its side panel closed and the Welcome is one column. A phone shows the editor or the agent, never both side by side: *Both* is not offered there. The side panel opens as a bounded overlay; choosing a file or tapping outside closes it. This does not change the desktop panel preference. The read-only run browser has a Files / Show code switch instead of squeezing the file list and editor side by side.

Editor toolbars and code keep their own horizontal scrolling.

### Folders Code can use

*Settings → Folders Code can use* (`settings.code.roots`) is separate from the terminal's list (`settings.terminal.roots`, §5); neither reads the other (`apps/hub-api/src/lib/code-folders.ts`).

- A folder is checked when added (`POST /api/code/folders/resolve`, and again when Settings saves): no `..`, no system folder, no dotfile or dot-folder in your home folder, no link leading out of home. It is stored as its real path. The desktop app's native picker goes through the Tauri dialog plugin (`lib/desktop-dialog.ts`).
- Every saved folder is checked again on each use, so a folder later swapped for a link is skipped.
- At startup, a settings row with no `code` section gets a copy of the terminal's folders once; removing every Code folder stores an empty list.
- Settings are saved through `PATCH /api/settings`, which runs these checks; `PUT /api/preferences` refuses the `hub.settings` key.

### What the Changes view shows

The file **now** against **before the run** plus the agent changes you accepted (`GET /api/code/versions`: `start`, `agent`, `original`, `current`; accepting stores the accepted text as a blob in the repository, `POST /api/code/accept-content`):

- **Green / red** with *Accept · Reject*: an agent change, exactly as the agent made it, not yet decided. It is drawn as GitHub and Cursor draw a diff: added lines on a soft green with a tinted line number and a +, the removed lines above them on a soft red with a −, and the words that changed inside a line on a stronger tint (`githubDiff` in `components/code/review-editor.tsx`). The File view keeps only the change bars.
- **Blue** with *Your edit · Revert*: anything else that differs, including an agent change you typed over (here, in another editor or in the terminal; git cannot tell who typed). Your edits never need review.
- Accepted and rejected changes leave the diff; a file with nothing left to decide shows no count.

Whether a change is decided is read from the **text**: type over it and it is yours, reject it and it is rejected, Ctrl+Z either and it is pending again. Changes on neighbouring lines (or separated only by an empty line) count as one.

Progress shows as *"17 / 23 · 2 files left"* in the status bar, a ring per file and a badge in the list (`GET /api/code/progress`).

If another program writes the file while you have unsaved typing, **nothing is overwritten silently**: a bar offers *Keep mine (overwrite)* or *Use the version on disk*, and your text stays until you choose. With nothing unsaved the file simply reloads and the status bar says *Updated from disk* for a moment (it is reread every 10 seconds and when the window regains focus).

In a repository opened from the Explorer the same editor compares with the index: *Stage* (Alt+Y) stages that change as shown, *Discard* (Alt+N) puts the staged lines back.

The theme picker (`components/code/ide-theme.tsx`, shared with plot code panes) saves the selected theme ID and favourites in account settings, and its sanitised palette through `GET/PUT /api/settings/editor-theme/current` (independent of the Code module). Built-ins, Open VSX and imported JSON/JSONC/VSIX colour data restore across browsers and are shared with Node's editor selection.

Imports read bounded colour data and never execute extension scripts. Local caches retain recent palettes for fast loading. Code always uses a coding font (Cascadia Code → Consolas, ligatures off) at its own size.

---

## Where Code runs

**On the computer** (desktop app or a local server), Code works on the folders in *Settings → Folders Code can use* and Ensemble's workspace through `/api/code/*`.

**On Ensemble on the web**, the server's own folders, repository operations and shell are operator-only (`lib/hosted-access.ts`); `/api/shell` reports this as `hostCode` (`canUseHostCredentials`, `routes/views.ts`).

While it is false (`useHostCode` in `lib/use-module.ts`) the web makes no `/api/code/*` call: Code (`app/(hub)/code/page.tsx`) lists your computers; sidebar prefetch (`lib/prefetch.ts`), the repository lists in Settings and the Assign dialog (including `/api/workspace/*` checkouts and trusted folders) skip those reads; Today's *Reviews* tile points to Code.

The API's `HOST_ACCESS_DENIED` is the fallback before the shell loads. The host terminal is off when `ENSEMBLE_TERMINAL=off`, and in hosted production unless `ENSEMBLE_TERMINAL=on`.

On the web the tab works on your paired computers (`lib/code-home.ts`), one at a time (§1): the Explorer lists the chosen computer's **repositories** (its Code folders and Ensemble's workspace) and *Changes to review* its **agent changes**, read from that computer.

Opening one gives the same review page as on the computer (`/code/review?device=<id>&review=<id>` or `&repo=<path>`), with Source control (stage, commit, push, pull, Actions), the IDE theme and the passkey-unlocked **Terminal** (§5). Each call is relayed to Ensemble on that computer ([25 §4.7](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#47-the-code-tab-and-terminal-on-the-web), `lib/code-target.tsx`):

- only from you, in your browser; never an API key, an agent or the assistant;
- never git's own files or secrets files; keys in code are hidden and a file holding one is read-only; files over 1 MB are read-only;
- the computer's switches decide what the web may do: *Show task files on the web* (reading), *Change code from the web* (every change), *Terminal from the web* (Settings → This computer, or `ensemble web`).

The computer must be online with CLI 0.3.8+ or desktop app 0.3.5+ (0.3.9+ / 0.3.6+ for the full editor); otherwise its Explorer section or the editor says what is missing. With no paired computer, the Welcome says so in one line and offers *Pair a computer*.

Failed review or repository queries show the error and Retry; they never claim there is no work. A folder that cannot be opened shows the error with *Try again*, and a file that cannot be read shows its error in the editor; a later read that fails (offline, the computer asleep) keeps the editor as it is. A denied terminal-status request shows an error, not "Opening the terminal…".

Ensemble Node has a separate chat-side original-file editor using this relay and the same colour-theme conversion, including non-Git text folders, autosave with version conflicts, and selected-line quotes. It needs Code API 3 (CLI/desktop 0.6.4+); it does not change this tab's repository reviews or terminal unlock. See [35 §8.18](35_ENSEMBLE_NODE.md#818-original-files-in-the-node-workspace).

The task page's *Review changes* opens the same review. A repository the agent cloned is not a change; its edits inside one are.

**A run's files** (`components/code/run-code.tsx`, `/code?job=<id>&file=<path>`) open in a second tab of Code's window, read-only: the changed files (A, M or D with line counts) and *Folder on <computer>* on the left, the file read-only and highlighted (CodeMirror) on the right.

On the desktop app and local servers a changed file opens from the copy the computer sent when the run ended (*as the run left it*); *Now* reads it again. **Ensemble on the web keeps no copy** (`keepsRunFileText` in `lib/hosted-access.ts`, [25 §4.6](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#46-a-tasks-files-on-the-web)): every file is read from the computer when opened, so it must be online.

The folder is read one folder or file at a time under the rules in [25 §4.6](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#46-a-tasks-files-on-the-web); only the person whose computer ran the task sees file text. It needs CLI 0.3.7+ or desktop app 0.3.4+ and *Show task files on the web* (`ensemble browse on`). Full screen fills the window (Esc leaves).

The run preview's *Files* and the task's *Agent output* link here.

---

## 3. Commit, push, pull request

Open **Source control** to choose what to commit. It groups **changes from this run**, selected by default, and **your changes**, unselected by default (`components/code/commit-panel.tsx`, `GET /api/code/commit-plan`).

The subject follows the 50/72 guide (counter amber past 50, red past 72; description lines over 72 counted), the description is Markdown with *Write | Preview*, and `Co-authored-by: Ensemble agent (<model>) <agent@ensemble.local>` is added when the run's files are included (a box turns it off). Committing run files with undecided changes asks first. Drafts are kept per run on this device.

The commit is built from **exactly the ticked paths** (`POST /api/code/commit-paths`): a throwaway index from HEAD, each file stored as on disk (`hash-object --no-filters`, so no repository filter runs), hooks never run, and HEAD moves only if it has not moved. Other staged work stays staged. The author is your git config, else your Ensemble account's name and email.

*Push* runs `git push -u origin HEAD` with the computer's own git sign-in and hooks off, and asks before pushing to the default branch (origin's HEAD). *Pull request* (GitHub remotes) starts from the repository's template (`.github/pull_request_template.md` and the usual places) or the agent's report, with a base branch and *Draft*, and opens it through GitHub's API (`POST /api/code/pull-request`) using the git token in Settings, the GitHub connection, or `gh auth token`.

The rest of the panel shows staged and unstaged files (stage, unstage, discard), recent commits, pull, and GitHub Actions runs for the branch.

---

## 4. Which branch the agent works on

Before assigning a run, open the Assign dialog’s **Optional information → Which branch the agent works on** and choose:

- **Use as is (default)**: nothing is created or switched. Your own folder is used as it is; Ensemble's checkout stays on the branch it was cloned on.
- **Existing branch**: the run switches to that branch, any branch, fetching it when it is only on the remote.
- **New branch**: `git switch -c <exact name>` before starting, in Ensemble's checkout or your own folder (uncommitted work carries over); an existing branch of that name is switched to.

---

## 5. The terminal, for you only

A terminal panel under the editor (resizable, §1) for what would otherwise send you to a shell: make or switch a branch, install a package, run tests, commit and push. It opens:

- **on the computer itself**, at Ensemble's page on `localhost` (`routes/terminal.ts`). The desktop app's window shows a note instead, because its webview cannot run the passkey check (`components/code/terminal-desktop-note.tsx`);
- **on Ensemble on the web, for a paired computer**: the Terminal button on its Explorer section in Code, *Terminal* with that computer selected, or in a review of its code. Commands run on that computer through the relay ([25 §4.7](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#47-the-code-tab-and-terminal-on-the-web), `remote/terminal.ts`).

**It is not a shell:**

#### Who

a **passkey** with user verification (Touch ID, Windows Hello, a phone or a security key) once per session: 30 minutes idle, 8 hours at most, *Lock now* any time. No agent, MCP call, API key, script or the assistant can produce one, and every terminal route refuses anything but a signed-in browser on Ensemble's own page.

Adding a passkey needs the account password, or on the web, for an account that signs in with Google or GitHub, a code mailed to the account.

On the web the passkey covers only the terminal; review, editing and Source control use your sign-in and the computer's *Change code from the web* switch. A locked terminal (*Lock now*, `lock`, or expiry) refuses commands with `423` and code `TERMINAL_LOCKED` (`lib/terminal-human.ts`), never `401`, so you stay signed in and the panel returns to its unlock button.
#### What

one allow-listed program at a time, run by name, never through a shell: no pipes, redirects, `;`, `&&`, `$()` or backticks (`parseCommand`, `checkProgram` in `workspace/guard.ts`). `git` is hardened: hooks off, no fsmonitor, no `ext::` transports, `--force` refused in favour of `--force-with-lease`.

Developer tools (`python`, `pip`, `uv`, `node`, `npm`, `pnpm`, `pytest`, `make`, `cargo`, `go` and similar), file tools (`ls`, `cat`, `grep`, `find`, `mkdir`, `cp`, `mv`, `rm` and similar) and `curl`/`wget`. Shell scripts run only as `sh script.sh` inside the sandbox, never `sh -c`. Never: `sudo`, `ssh`, `docker`, `osascript`, `open`, `launchctl`, `security`, `env`, `kill` and the rest of `NEVER`.

Destructive commands (`git reset --hard`, `git clean`, `git restore`, `git checkout --`, deleting a branch, a forced push, `rm -r`) need you to type `yes`. Built in: `cd`, `pwd`, `clear`, `help`, `lock`.
#### Where

Ensemble's workspace, folders tasks ran in, and folders added in *Settings → Terminal and commits*; never above them, never a system or credential folder (`workspace/terminal-exec.ts`, shared by both terminals). Commands run under the computer's OS sandbox ([24](24_DESKTOP_SANDBOXING.md)): files change only inside the folder; home and app data are unreadable.

From the web, a computer without a working sandbox refuses commands (`ensemble sandbox setup`). 15 minutes per command; the web shows up to 1 MB of output.
- **Record**: the computer's ledger records that a command ran (arguments, folder, exit code; `via: "web"` from the web), **never its output**. Ensemble on the web records the unlock and which computer ran a command, and keeps output only while you read it (an hour at most, in Redis).

*Settings → Terminal and commits* can turn the terminal off on the computer; *Terminal from the web* (Settings → This computer, or `ensemble web terminal off`) turns off only the web's.

### Passkeys and addresses

A passkey belongs to the **site it was made on** and stays on the device that made it (or your phone or key). On the computer's own page register at `http://localhost:<port>`, not `127.0.0.1`: browsers refuse passkeys on a raw IP. On the web it belongs to the web's address (`app.ensemblework.com`), so one passkey opens the terminal on each paired computer.

The fingerprint or PIN never reaches Ensemble.

On the web, Settings shows **Unlock to manage passkeys**, which runs the same check as the terminal; removing a passkey needs an unlocked session. The buttons stay visible for touch and keyboard users.

---

## 2. What a run is answerable for

Each code run records **two snapshots** of its folder as git trees, using a throwaway index so your staging area is untouched:

- **start**: the folder as the job found it, including staged, unstaged and never-added files;
- **end**: as the job left it.

Both are pinned as `refs/ensemble/review/<job>/{start,end}` for **14 days** (each in its own commit, `CodeReview.startCommit` and `endCommit`; `pinReviewSnapshots` in `lib/code-commit.ts`) so git's garbage collection cannot remove them. The daily retention pass then unpins them and marks the review expired (`runRetention`); *Show expired* lists those.

A run that writes in a repository its folder's snapshot does not cover (another folder it was allowed to write, or a repository nested in a folder that is not one) snapshots that repository at its first write there; its changes are listed with the run's files, and when the run folder itself has none the review is of that repository ([25 §4.6](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#46-a-tasks-files-on-the-web)).

Code opens a review's repository even outside *Folders Code can use*: Ensemble recorded it.

The review is start → end, so work you had before the run is never shown as the agent's; Source control lists it as *Your changes*, unticked. Git-ignored files have no snapshot; changed ones are listed as *Changed, can't be reviewed*. Failed and stopped runs get a review too, and their changes stay in the folder until you decide.

*Accept all* (`POST /api/code/reviews/:id/accept`) keeps what is on disk; in Ensemble's checkout it commits the agent's files on the run's branch with hooks off, while an outside folder is left uncommitted.

Only the run's files git still sees are staged (on disk, or tracked and so staged as a deletion); one that is gone, such as a file the run removed again or that was committed and moved since, is skipped instead of failing the commit. *Discard all* (`POST /api/code/reviews/:id/discard`) puts the agent's files back as the run found them; the agent's commits are undone only in Ensemble's checkout, otherwise kept and reported, and an agent-owned task waiting for approval or done returns to Todo. *Push* on a reviewed run pushes the run's branch to its `origin` without force, with the computer's sign-in (`git push -u origin HEAD`).

---

## 9. The agent

Switch Code to **Agent** to work with your own agent: Claude Code, Codex, Cursor's agent, GitHub Copilot, Grok Build, OpenCode, Gemini CLI, Antigravity, Mistral Vibe, Qwen Code or Kimi Code, signed in on the computer it runs on ([30](30_ENGINES.md)). Ensemble does not take the provider's sign-in or run the agent on its servers. No repository is needed: a thread can work in a folder, or in no folder at all for work such as a page, a board, a diagram or a plot (it then gets a new folder in Ensemble's workspace when it needs one).

| You want to… | Do this |
|---|---|
| Start | *New thread* in the side panel, the **+** beside the tabs, or *Code with an agent* on the Welcome. Over the message box pick the computer (its list is read again as it opens, each online or when last seen) and the folder: *No folder*, or one picked with the folder picker (§1 *Open a folder*), × going back to none. A computer is fixed once a folder is picked, and a thread keeps both once it starts. The branch chip switches the folder's branch or starts a new one (not while the agent works there). In a repository's window the thread works in that repository. Type and press Enter (Shift+Enter for a new line). The thread is named at once from a few words of the first message, without a model (it reads only the first two lines, so a long paste costs nothing); double-click its tab to rename it |
| Point it at your work | Type @ for a task, a person, a project, a file, a diagram or a plot, as in pages and the assistant. The agent gets each as a record its Ensemble tools open |
| Pick the agent and model | The agent chip: your AI plans signed in on that computer, with each model's cost and context sizes |
| Set thinking, context window, fast mode | The chip beside it, when the model has them. Thinking is a slider from the model's lowest level to its highest, warming as it goes up; *Auto* beside it leaves the level to the model, where it has a default. The context window shows only the sizes that model offers (272K, 1M) |
| Decide how much it may do | *Ask*, *Review only* or *Run unattended* (the run modes of [24](24_DESKTOP_SANDBOXING.md)); the rest comes from your default run profile |
| Choose which connected apps it may use | *Tools*: each connected app or server, and each of its tools, on or off for this thread, with why one cannot be on; the chip counts what is off. A new thread starts from your default run profile's, and the thread keeps its own until you change it ([Context Bridge §5.5](CONTEXT_BRIDGE.md#55-choosing-which-apps-an-agent-may-use)) |
| Find a thread | The side panel lists the threads on the computer shown (in a repository's window, its computer): *Pinned* first, then one group per folder, *No folder* for the rest, each with its agent, how long ago it worked and a dot: yellow while it works, green when a reply is in that you have not read, red when it stopped on an error, gray once read (kept in this browser, `ensemble.code.seen`). Find one by its name |
| Notifications | None while you are on the Code tab: the dots show it. Away from it, a finished or stopped turn notifies once and opens the thread |
| Rename, pin, delete | Double-click or F2 renames, in the list or on the thread's tab; right-click a thread (or its tab) for Open, Rename, Pin, Open the folder in the editor, New thread in this folder, Keep the last reply in Ensemble, Copy a link, Stop and Delete. Delete (or the Delete key) is at once, with Undo: the thread waits 7 days in the **Bin** at the foot of the list, where it can be restored or deleted for good, then goes by itself. Right-click a group for a new thread there, the folder in the editor or its path; right-click a turn to copy it, quote it, keep it, review its changes, open its run, use its message again or **Fork from here** (the next message starts a new thread in the same folder, in a new session with a handoff record of this one up to that turn; this thread stays as it is) |

The Code tab has its own agent, so the assistant's button and panel step aside there and come back as they were on any other tab.

### Watch, steer and answer the agent

| You want to… | Do this |
|---|---|
| Watch the work | Each turn streams its work while it runs: its thoughts (a title, opened for the rest), commands with their reason, opened as a terminal with the output and exit code, edits as their changed lines, reads and searches, and Ensemble's tools by what they did (*Made a page*). Icons mark only commands, edits and Ensemble; the line being worked on shimmers. *Log* shows the run's own log. It then folds to *Worked for …*. A file in a row opens in the editor, even while the turn runs |
| Know why nothing happens | A turn waiting on a computer that is offline says so in the thread, with how to bring Ensemble back there (open the app, or `ensemble runner start`) and *Cancel*; it starts by itself when the computer is back |
| Change what it is doing | Type while it works: **Steer** (Enter) changes the turn at work, which goes on in the same session with what it did; **Stop and send** (Ctrl or ⌘+Enter) stops it and sends the message next. A turn not started yet takes the message into its own |
| Answer a question or a permission | It shows in the thread, answered in one press: *Allow*, *Allow for this run* or *Don't allow*, or a question's option or your own answer. While the thread is open on your screen, its requests wait there and not in Needs me; closed, they wait in Needs me with an alert that opens the thread |
| Stop | The square button while a turn works |

### Threads as tabs beside your files

| You want to… | Do this |
|---|---|
| Work in several threads | Each thread opens as a tab beside the open files, with a mark that moves while it works. Click a tab to switch, middle-click or × to close it (the thread stays in the side panel); right-click for *Close the other threads* and *Show it beside the editor* |
| See a file and the agent together | **Both** in the window's switch, or the panel button at the end of the tabs, puts the agent beside the editor: files on the left, threads on the right. Drag its left edge (340 px to about half the window, remembered); dragging well past half shows the Agent view instead. A file the agent is editing updates as it writes, says *The agent is editing*, and its tab shows the agent's mark; typing of yours not saved yet is kept, and saving asks which to keep |
| Review what it changed | The turn's *files changed* list opens each file in the editor's review of that turn; accept (Alt+Y) or reject (Alt+N) there |

### Keep what the agent made

| You want to… | Do this |
|---|---|
| Open what it made | Ensemble records the reply links to (a file, a page, a task, a diagram, a plot, meeting notes) show as cards under it |
| Keep a reply | Under a reply: *Copy* and *Keep*, one picker with *Page*, *Task*, *Meeting* and *Deliverable*: a new page, any page, a new task on a board you pick (or the Inbox), any open task, new or existing meeting notes, or a deliverable's notes. *Add to* a mentioned task's page and *Mark* it *done* are one press. No model is involved: the reply goes at the end as the agent's block, marked with the agent, model, folder, computer, time and a link back to the thread, and the turn shows *On* where it went |
| Ask for what comes next | After the last reply, suggestions such as updating a mentioned task on its board or running the tests put a message in the box to send |

### How a turn ended

Under a finished turn one line keeps each state apart: the conversation (*Finished*, *Failed*, *Stopped*), the files (*N files changed* or *No file changes*), the checks (*Checks passed*, *Checks failed*, *Checks uncertain*, *Checks not confirmed*), whether you accepted the work (*Accepted*, *Discarded* or *Not accepted yet*) and a pull request (*PR opened*, a link). The agent saying it is done, its checks passing and you accepting the changes are separate: passing checks are not acceptance. The ⓘ lists each check: what the agent said, and what Ensemble's own run showed.

The checks are Ensemble's, not the agent's word: the agent reports each check it ran with `report_result`, with the command to run it again, and after the turn ends Ensemble runs each of those commands itself in the same folder, under the turn's own rules (the hard floor, the folder rules and the mode's questions), with the programs and home folder the agent's own commands had, and 10 minutes per check. A check runs in the turn's folder, or in another folder only when the turn was already let into it. A check's exit code decides: 0 passes, anything else fails, and so does a run whose own test summary counts a failure. When the agent also gave a line the output should show, it is compared without colours, reporter marks (`#`, `ℹ`, `✔`, `•`…), spacing or case, but with its numbers; a check that exited 0 and showed something else is *Checks uncertain* (the ⓘ says what was expected and what it saw), never *Checks failed*. A test runner's output (`npm test`, `node --test`, pytest, cargo test, go test, Vitest, Jest) depends on its reporter, so for those only the exit code counts. A check without a command, one whose program is not on this computer, and one in a folder the turn may not use stay the agent's claim (*Checks not confirmed*), never *Checks failed*. *Accepted* is set by *Accept* or *Mark reviewed* in the review (all changes rejected counts as *Discarded*), *Discarded* by *Discard*, also while the checks run: Ensemble keeps your choice, and after *Discard* runs no more of them.

### What the agent gets with each message

The first message of a session goes with Ensemble's instructions for the Code tab: where the agent works and how this run works (the folder, the internet, git, the mode, secrets), the instructions of your default run profile, the skills it can read in its own skill folder, the Ensemble project, what Ensemble knows around the records the thread names (the task you @mention, its people, related work; within about 5,000 characters), what done means (acceptance criteria written in the message or the task, under a heading such as *Acceptance criteria* or *Done when*, or as `AC-1: …` lines, each with an id the agent reports its checks under) and today's date. Later messages in the same session go as you wrote them, after only what changed since: a record that changed, the run's rules or the run profile after you changed them, new acceptance criteria, a new day. A message while the agent works (Steer) tells it the work changed.

Skills go into the agent's own skill folder inside the folder it works in (`.claude/skills` for Claude Code, `.agents/skills` for Codex and Antigravity, `.github/skills` for GitHub Copilot, `.cursor/skills` for Cursor, `.gemini/skills`, `.opencode/skills`, `.grok/skills` and the others' own), as `ensemble-<name>` (Ensemble's) and `owner-<name>` (your skills linked to the task the thread names, or @mentioned) folders with a `SKILL.md` each, kept out of git through the repository's `.git/info/exclude`. Never into your own home folder's skill folders. That folder also holds the repository's and your own skills, so Ensemble keeps a record of the folders it wrote (`.ensemble/skills.json`, also out of git) and changes or removes only those, while they are as it left them: a skill the repository keeps in git, one you made or one changed since stays as it is, even under an `ensemble-` name, and Ensemble then gives none of that name. A read-only turn gets no skills written, and the agent is told nothing new about them: they are as its session last had them.

### Two layers in one conversation

The agent does the coding with its own tools in its folder: reads, edits, runs tests, commits and pushes, under the run's permissions. Through Ensemble's tools it also works in your Ensemble, in the space that is open: it reads and searches tasks, pages, boards and meetings, makes and changes pages, boards, diagrams, plots and tasks (at once, with Ensemble's Undo), and uses the apps you connected. It makes a task card only when you ask for one. It never changes settings, sharing, keys or the folders Code can use.

Each message continues the agent's own session, so it remembers the thread; another model of the same agent and plan stays in that session from the next message. Choosing another agent or plan mid-thread starts a new session that gets a **handoff record** of the earlier one, and the thread shows the line *New session with …, handed over from …*: what you asked, what worked and what failed, the checks, files and your decisions, a summary and never the whole conversation ([41](41_AGENT_SESSIONS.md#1-coding-sessions)). The composer says so before you send. A thread in a folder works on it as it is, on its current branch; use Source control to commit, push or open a pull request. A thread's computer and folder are its own once it has started.

On the web the thread runs on the paired computer you pick. In a folder it has the same switches as the editor: *Change code from the web* must be on there, the folder must be one Code can use there, and that computer needs a version of Ensemble that runs the agent in a folder (`capabilities.codeAgent`; 0.8.2 and earlier do not, and say so with the version). A thread with no folder runs on any paired computer.

## 7. In a space shared with you

Code is view only for people a space is shared with ([29](29_SHARING.md)): they read reviews, files and diffs, but every `/api/code` write (accept, reject, edit, commit, push, discard) and the terminal stay with the owner. A paired computer's code on the web is only ever its owner's, whichever space is open.

Code's window shows **View only** instead of the terminal and review actions, and the editor is read-only. The agent's view lists the threads and their turns without the box to send. A single "code" share opens the review list the same way.

The **Search and jump** dialog offers **Local repositories** and **Code reviews** as destinations (`/code#local-repositories` opens the Explorer, `/code#reviews` the *Changes to review* panel).

## 8. Limits and residual risks

- Not supported: side-by-side view, a change overview on the scrollbar, autocomplete, go-to-definition, formatting (it is a review-and-edit surface with highlighting, brackets, indentation, multi-cursor and find/replace, **not a language server**), an interactive shell or programs that wait for typed input, and diffing in a Web Worker.
- **Agents with the sandbox off run as you.** The terminal adds nothing they can reach, but only the OS sandbox separates them from your account.
- A process running as you could register a passkey first. Every registration is in the ledger and listed in Settings, so an unexpected one is visible and removable.
- Allowed programs are powerful by design: `git` follows repository config (hardened, not eliminated), and `npm install`, `make` or `pytest` run the repository's code, inside the sandbox.
- **On the web, Ensemble's server relays the commands.** While the terminal is unlocked, a compromised Ensemble on the web could send allow-listed commands to your computer, and it can always send Code calls (reading, and changing code unless turned off). The computer still applies its allow-list, folders, sandbox and switches; turn off *Terminal from the web* or *Change code from the web* there to rule them out.

## In the code

### 9. The agent: implementation reference

- **View.** `components/code/agent-view.tsx` (the thread, its place bar and composer), `agent-sessions.tsx` (the side panel's list and its Bin) and `agent-actions.tsx` (the right-click menus, renaming, deleting and the keep picker). The place bar uses `machine-switcher.tsx`'s `machineState`, `folder-picker.tsx` and `branch-menu.tsx`, shared with the editor's window. `ide.tsx` and `code-home.tsx` keep each open thread as a tab (`MAX_THREAD_TABS` 8, `new` for one not started), one `AgentView` per tab, mounted while open and hidden unless shown; the IDE shows the agent in place of the editor or beside it (`ide-agent-side`), and the sessions in the side panel (`Panel` `agent`). The thread's data, tool rows, outputs, thoughts, record links and groups are in `lib/code-agent.ts` (`toolLine`, `commandOf`, `toolOutput`, `editLines`, `inputLines`, `thought`, `recordLinks`, `threadTitle`). Its layout (a work log per turn, tool rows by kind, the turn's changed files with line counts, a place bar over the composer, threads grouped by folder) follows T3 Code's thread (MIT, Copyright (c) 2026 T3 Tools Inc.) and Cursor's agent, drawn with Ensemble's components: `AgentPicker` and `TuningPicker` in their `compact` form (thinking as `components/agent/thinking-slider.tsx`), `MentionTextarea`, `MarkdownText`.
- **Live.** A live turn's thread and run steps are read every 1.5 s, and the `workspace` and `decision` server events refresh them at once (`components/live.tsx`); a paired computer sends its steps every 2 s. The reply streams from the steps while the turn works. *Log* reads `GET /api/agent/jobs/:id/logs` (a paired computer's) or the job's own log. A queued turn on a paired computer the web sees offline (`deviceOnline`) says so in the turn. The files the live turn edits go up to the IDE (`onEditing`), which reads those open files every 1.5 s instead of 10 s; a file with no unsaved typing reloads, one with typing keeps it and its save asks.
- **Addresses.** `/code?view=agent&thread=<id>` opens a thread on Code's home (`thread=new` a new one, `device=` and `repo=` where it starts); `/code/review?repo=<path>&view=agent&thread=<id>` in that folder's window (`agentHref`). A thread whose folder is not the window's opens where it works. Kept in this browser: the thread in view per folder (`ensemble.code.threads`) and on the home (`ensemble.code.homeThread`), the threads open as tabs (`ensemble.code.threadTabs` per folder, `ensemble.code.homeThreadTabs`), the agent beside the editor (`ensemble.code.agentSplit`) and its width (`ensemble.code.agentSideWidth`), whether the Bin is open (`ensemble.code.binOpen`), where a new thread starts there (`ensemble.code.draftPlace`), pinned threads (`ensemble.code.pinned`), folded groups (`ensemble.code.closedGroups`), the agent, model and mode (`ensemble.code.agent`, `ensemble.code.agentMode`), the board for a kept reply's new task (`ensemble.code.keepProject`).
- **Threads.** A thread is an internal task off the board (`sourceRef` `code:<key>`, the key a hash of the computer and the folder, or of the computer alone for no folder; `codeThreadRef` in `lib/node-tasks.ts`, kept out of board lists by `ON_BOARD`). `routes/code-threads.ts`: `GET /api/agent/threads` lists every thread with its place (`threadPlace`, read from its first turn: the computer, the folder or none, the folder it works in) or, with `folder=&deviceId=`, one folder's; `POST /api/agent/threads` makes one (`folder` null for none) named from the first message (`threadTitle` in `packages/shared-types/src/thread-title.ts`: greetings and "can you" go, links and paths become a word, then the request's action word and its first phrase of meaningful words, split at stop words as RAKE does, at most 6 words and 48 characters); `GET /api/agent/threads/:id` returns its place, its turns in order (each with where it was kept, `steer` for a message sent while the turn before worked and `steeredBy` on the turn it stopped) and its pending requests (`asks`). Rename and delete are the task's own `PATCH`/`DELETE /api/tasks/:id`; the Bin is `GET /api/agent/threads?bin=1` (threads deleted in the last `CODE_THREAD_BIN_DAYS`, 7, with `deletedAt` and `purgeAt`), `POST /api/agent/threads/:id/restore` and `DELETE /api/agent/threads/:id` (only from the Bin; ledger `code.thread_purge`), and the daily retention pass deletes the older ones for good (`jobs/retention.ts`). A thread whose first message cannot start is deleted again.
- **Steer and stop.** `POST /api/agent/threads/:id/steer {jobId, turn}` with the turn at work and the next message's assignment: a turn still queued takes the message into its own (`amendedMessage`, mentions together); one at work gets a new turn that continues it with `context.steer` (the computer resumes the session with a prompt that leads with the steer note, `steerPrompt`, then the new turn's message with what it mentions read in full, on a paired computer as the web read it, as Ensemble Node steers, [35](35_ENSEMBLE_NODE.md)), turns queued after it now follow the new one, and the one at work stops (`stopJob`; ledger `code.agent_steer`). *Stop and send* is `stopJob` and then the usual assign continuing the stopped turn, which waits for it to end (`queue-policy.ts`).
- **Requests in the thread.** An open thread posts `POST /api/agent/threads/:id/watch {open}` every 15 s while the browser tab is visible, and `open: false` when it is hidden or closed (`useThreadWatch`). The mark lives 40 s in Redis (`lib/code-watch.ts`). While it does, `GET /api/decisions?surface=hub` and the Needs me count leave out requests whose `detail.taskId` is that thread (`withoutWatchedThreads`), and a new request makes no Needs me alert (`threadAlert`, in `devices/routes.ts` and `workspace/tools.ts`); a thread's request at any other time alerts with a link to the thread. The thread answers with `POST /api/decisions/:id/decide` in one step: a risky allow is sent `confirmed`, as the press is the confirmation (the Needs me card for a computer's request does the same).
- **Turns.** Each message is `POST /api/agent/assign` with `chat: true`, `surface: "code"`, the folder (none for no folder), `continueFromJobId` of the turn before, `branchMode: "as-is"`, `markDone: false`, the default run profile's sandbox, internet, git and limits (none unless the profile sets them) and its instructions as `profileInstructions` (kept in the job's context, sent with the packet, never shown as part of the message). Its @mentions (people, projects, tasks, pages, meeting notes, files, diagrams…) follow the message as handles (`withMentions`: `(Mentioned in Ensemble: @Label [task] ensemble://task/<id>; …)`), which the thread shows as chips again (`splitMentions`). When the turn is made, what a mentioned page, task, meeting notes or file says is read and goes with the message after `(Attached from Ensemble:` (`withMentionedContent` in `workspace/mentioned.ts`): the page's text, the files on it with their text where there is room, and the pages inside it, within the 8,000 characters a computer takes, shared between them. The records are read where they are: a turn a paired computer takes from the web arrives with what the web read and goes to the agent as it came (`createJob` on the computer: a job of web origin whose message `hasAttached`), since the computer has no copy of the web's records; a turn made on the computer gets what it mentions read there. Content a message carries already stays when none of its records can be read where the turn is made (Run again on the computer). `ensemble_context` with such a handle returns the same in full (up to 12,000 characters) before what is around the record. The job's context keeps `chat` and `surface` (`codeTurnOf` in `workspace/trust.ts`). The work log reads the run's steps (`GET /api/runs/:id`) while the turn runs and when it is unfolded; the reply is the job's summary. A finished turn's files are its evidence; each opens `/code/review?review=<id>&file=<path>&view=editor` (on the web `device=<id>` and the computer's review id).
- **Keeping a reply.** `POST /api/agent/threads/:id/save` with the turn's `jobId` and one of `pageId`, `taskId`, `newPage: {title}`, `newTask: {title, projectId?}` (`createTask`, To do, yours, on that project's board or the Inbox), `meetingId`, `newMeeting: {title}` or `deliverableId` writes the asked message (quoted), the reply and the files it changed. On a page or a task's page it is one `agentBlock` at the end (`keepAgentOutput` in `pages/agent-output.ts`, after writing back what is being typed there); in meeting notes the same block at the end of their document (`keepAgentOutputOnMeeting`, new notes as an ended meeting); in a deliverable's notes a Markdown section between two marks with the agent's line (`keepAgentOutputOnDeliverable`). Keeping the same turn again replaces what it wrote there. The block's attributes name its `source` (`code-agent`), `engine`, `model`, `threadId`, `folder`, `computer`, `jobId`, `runId` and time, and the page shows them on the block's bar (`components/editor/agent-block.tsx`, `packages/shared-types/src/page-schema.json`). The run records a `code_saved` event (`KeptPlace`: kind, id, title and link) and the ledger `code.agent_output_kept`. Marking a mentioned task done is the task's own `PATCH`, with Undo.
- **Tools.** A code turn's MCP server runs with `ENSEMBLE_CODE_AGENT=1` (`mcpEnv` in `workspace/engines/registry.ts`): besides `ask_person`, the board's `ensemble_list_tasks` and `ensemble_create_task`, it has `ensemble_context`, the ranked `ensemble_search`, `ensemble_actions` and `ensemble_act` (the run allowlist of `bridge/actions.ts`) and the connected apps ([30](30_ENGINES.md)). `/api/engine/tool` answers them for a code turn as for a task run (`isCodeAgentTurn`), and `report_result` and `attach_evidence` too (`evidence/run-tools.ts`; the job's `report`, or `.ensemble/result.json`).
- **Packet.** `workspace/code-turn.ts` `prepareCodeTurn` (called from `executeJob` in `workspace/agent.ts` for a code turn) builds each message's prompt with `buildPacket` (`workspace/turn-packet.ts`) from the sections in `packages/prompts/sections/code/` and the constitution's: stable (who and where, authority, acting, asking, permissions, knowledge, sources, records, the run's rules from `engineRules`, `report_result`, completion states), context within 5,000 tokens in this order (run profile, skills, project brief, the Context DB slice, cut by its last facts) and volatile (acceptance, date, a handoff record, the message). The facts come from `packetSource`: `workContext` of the board task, else of the newest records the thread @mentions (at most 4, sharing 5,000 characters), the project (mentioned, else the task's), the owner's skills linked to those tasks or mentioned (at most 6), those tasks' acceptance criteria (`acceptanceOf`) and the time zone. `contextItems` keys each fact by record, list and handle, so a renamed task is the same fact changed; facts that share a key (two lines with the same label) each get a short hash of their own text after it (`uniqueKeys`, also for the facts a claim carries), so which is which does not depend on their order, and a later turn takes the same text under the other form of its key (alone now, or beside a namesake now) for the same fact: only a line really added or removed is named. The run keeps the record in `Run.packet` (`code.packet.v1`: mode `full`, `delta` or `none`, `version` and the session's `base` version, each section's characters and tokens, what was cut, counts, skills, criteria, the session operation, and `delivered`: a hash per fact, of the rules, profile, skills, criteria and the date), and its `version` in `Run.promptVersion` once the agent has the prompt (`keepCodeTurn`), so a turn that fails before then leaves no packet to compare against. Before each attempt goes, `keepCodeTurnContext` keeps the turn's provenance, best-effort: the version, the owner skills in `Run.skillIds`, every skill's `{id, name, source, sha256}` in `Run.skillSignatures` and its context pack ([06 §4](06_MODULE_WORKSPACE_AND_SURFACES.md#4-evidence-and-review)). A later turn compares against the session's last `delivered` (`lastDelivered`): new, changed and gone facts (at most 40 listed, the rest delivered next time), and the rules, profile, skills, criteria and date only when their hash changed; nothing changed sends the message alone. A steered turn that resumes its session leads with the steer note (`steerPrompt` around the packet): what changed follows it, then the message, the job's instructions, which hold the mentioned records' content (`withMentionedContent`). A part of the harness that cannot be made (the skills, a handoff record) is logged (`warn`) and the turn goes on without it. The prompt registry lists it as `agent.code` (Settings, Prompts).
- **Checks and states.** `verifyRun` (`workspace/completion.ts`) runs after the snapshot and review: for each `checks[].rerun` of the job's report, `judgeEngineCall` as a `Bash` call (asked or refused as the agent's own command would be), then `runCommand` with `sh -c` (PowerShell on Windows), sandboxed as the run, `CHECK_TIMEOUT_MS` 10 minutes. The check's `cwd` goes through `rerunFolder`: in the run's folder (real path, `jailPath`, no link out of it), else a folder the run was let into (`grants` writable, `readGrants` read-only), never one that `holdsProtected`; anything else is not run, with why. The command gets the PATH, HOME and toolchain folders (`CARGO_HOME`, `PYENV_ROOT`, `NVM_DIR`…) the agent's own commands had (`agentCommandEnv`, from `agentEnv`, folders inside the run's folder left out; `engineEnv` of `runCommand`) and the run's saved secrets without the API-key variables no agent gets, in place of the fixed PATH and scratch HOME of Ensemble's own commands. `rerunVerdict` rests on the exit code: a time limit that ran out, a run whose own summary counts a failing test (`testCounts`: TAP, node:test, Jest, Vitest, pytest, Mocha, cargo, go) whatever its exit code, or an exit other than 0 fails; exit 127 (a program not found here) and a command that could not start are not run. After exit 0, `exit_0` passes, and an `outputMatches` line is compared by `outputMatch`: the pattern as written (a pattern with a nested quantifier as text), else as plain text (`plainLine`: no ANSI colours, no leading reporter marks such as `#`, `ℹ`, `✔`, `✖`, `•`, `-`, `>`, single spaces, lower case) on a line of the output or across lines, numbers included. A difference is `uncertain`, with `Output differed: expected …, saw …` (the line with the same words and other numbers, else the last line), and the checks state is `uncertain` unless one failed. For a test runner (`isTestRunner`: `node --test`, `tsx --test`, `npm`/`pnpm`/`yarn`/`bun test`, pytest, cargo test, go test, Vitest, Jest, Mocha) the line is not compared, as its reporter depends on the terminal and the version; the rerun's environment already has `NO_COLOR` and `CI` (and `TERM=dumb` outside Windows). Before each check `verifyRun` reads the run's `accepted` (`acceptedOf`): after a Discard the rest are not run. Each result is a `check_rerun` event. `completionOf` keeps `ensemble.completion.v1` in `Run.completion`: `conversation`, `files`, `checks` (`failed` when one failed, else `uncertain` when one differed, `passed` only when every reported check ran again and passed, with counts per verdict), `accepted` (`markAccepted`, from `POST /api/code/reviews/:id/accept`, `discard` and `complete`, on a paired computer recorded on the web's run as the relay answers), `pr` (from `pull_request` events and result links, or a `gh pr create`-style command's output) and the agent's `claim`. The same record ends every run assigned to a coding agent (a task's run, a node's session run, a plan step handed to one; `verifyRun` from `executeJob` for any code run that is not a chat turn): its reported checks and the commands its task's or plan step's acceptance criteria name (`acceptance`, `workspace/acceptance-checks.ts`) run again, and `taskStatusAfter` decides its task by Ensemble's runs (`verifiedOf`): done only when they passed, blocked with the failure when one failed, finished, not verified (`waiting_approval`) when one was uncertain or not run or none came back. Anyone can write a task's text (a shared space's members, an imported mail, a meeting, a connector's issue), so a criterion's command is taken only when it is a check: `acceptanceChecksFor` reads the description, notes and page through `instructionText` (up to the first section Ensemble added as information, the context, connected apps, attached files, embedded diagrams and data, and without quoted lines or fenced blocks), and `acceptanceCommands` takes a backticked span only where the criterion says it passes, succeeds or exits 0, or says to run it (never after "never run" or "do not run"), and only when `isCheckCommand` holds: plain words (no shell syntax, quotes, variables, globs or `VAR=` in front), every place inside the run's folder (no absolute path, `..` or URL), and one of the test, lint, build and typecheck forms (`npm`, `pnpm`, `yarn` or `bun test`; `npm|pnpm|yarn|bun run` of a script named test, lint, build, check, typecheck or verify with no deploy, release, publish, reset, drop, migrate, seed, clean, rm, push, prod, sync or the like in its name, never a file name; pytest, `cargo test`, `go test`, Vitest, Jest, Mocha, `tsc --noEmit`, ESLint, `ruff check`, mypy, each with known safe flags; `node <file>.js` or `python <file>.py` alone; git that only reads, `gitReadsOnly`). A file it runs (node's, python's, pytest's and mocha's paths) is a check's: its name has test, spec, check, accept, verify or lint as a word (`accept.js`, `check_output.py`, `tests/test_api.py`, `test/unit.spec.js`), its path none of those risky words, and it is never under `node_modules`, `vendor`, `.git` or a hidden folder. Never npx or another package runner, make, a shell, or an interpreter's `-e` or `-c`. Each command once, not run twice when the agent's own check ran it in the same folder; `from: "acceptance"` on the run. Before it runs them, `rerunChecks` holds each command to `isCheckCommand` again and to `checkCommandAt`: each file it runs must be in the run's folder (missing, or a link out of the folder, is not run, with why), and `npm|pnpm|yarn|bun run <name>` or `yarn test` runs only a script the package.json where it runs has, as yarn and bun otherwise run an installed program of that name (`node_modules/.bin`). Unless the run is unattended it asks the owner once for all of them on one card (tool `run checks`, *Run this task's checks: …*; an answer for this run counts), even in Review only and trusted folders; refused or unanswered, none runs. `checkCommandAt` holds each one again right before it runs, after the card and the checks before it, and the command runs each file as the real path checked, absolute and quoted, so a link an earlier check put in its place is not followed. Once allowed they are judged as in Review only, so nothing asks again, and a read-only run stays read-only. The agent's own reported checks keep their way through the judge. A check the run changed is not run: before the agent starts, `executeJob` hashes what each acceptance command runs (`checkBaseline` in `workspace/check-files.ts`: the files it names, the `package.json` script `npm|pnpm|yarn test` or `npm run <name>` uses and the files that script names; a `check_baseline` event), and before the checks run again `checkChanges` compares them (a `check_files` event). A check whose file or script changed, as the agent reported it or as the task names it, is `not_run` with *Not verified: the check itself was changed by the run (export/accept.js)…*, so the task is never done on it. A file that was not there at the start is the run's to write, and one the task's own words ask to change (`asksToChange`: a sentence names it and says change, edit, update or fix, not "do not change") is left out; the next run of the same task in a session starts from the earlier run's baseline when nothing changed it in between (`earlierBaseline`). The task moves only from the status the run left it in (`settleTask`: `in_progress` where `executeJob` starts it; on the web the status the claim left, `taskStatusAtStart` on the job's context): a status its owner set while the run worked or its checks ran stands, and the run keeps a `task_kept` event (the status kept, the one it wanted, what its checks showed) beside its completion record. A check that came without a command stays the agent's word: the turn's line says *Checks not confirmed*, but it neither holds the task back nor confirms it, and a run with nothing to run again ends as before ([25 §4](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md), [35 §8](35_ENSEMBLE_NODE.md)). Runs shows such a run as *Checks failed* or *Not verified* rather than *Done* (`verified` on `GET /api/runs` and `GET /api/runs/:id`, `runPresentation`), with this line of states (`components/runs/run-preview.tsx`). `markAccepted` and `saveCompletion` (the run's end, and the web keeping a computer's, `keepCodeTurnResult`) are one SQL statement each, and `saveCompletion` keeps an `accepted` already there, so an Accept or Discard while the checks run is not written over. `GET /api/agent/threads/:id` returns each turn's `completion`, `packet` (mode, operation, versions, sizes, skills, criteria) and `handoff` (`turnHarness`); `components/code/turn-states.tsx` draws them (`TurnStates`, `SessionStart`).
- **Sessions, handoffs and forks.** `prepareCodeTurn` takes the turn's `sessionOperation` (`workspace/sessions.ts`): another agent or plan, a fork, or a session the agent no longer has gets a handoff record built from the earlier session's runs (`buildHandoff` in `workspace/handoff-record.ts`), kept in `session_handoffs` and written to `.ensemble/handoff/<id>.md` in the folder (git-excluded); its rendering (`renderHandoff`, at most 8,000 characters, by priority) goes in the packet. `POST /api/agent/threads/:id/fork {jobId, turn}` makes the new thread (same `sourceRef`, title *Fork: …*) and its first turn with `continueFromJobId` of that turn and `fork: true` (`context.fork`; ledger `code.thread_fork`). The composer's *Fork from here* uses it (`forkCodeThread`).
- **Skills.** `writeSkillFolder` (`workspace/engines/skill-folders.ts`) writes `skillsToWrite(codingSkills(), …)`: Ensemble's bundled skills that need no Ensemble Node tool (`SKILLS` of `@ensemble/prompts`, at most 8, process skills first) and the owner's; folders made one level at a time, files written through a renamed new file, nothing through a link (`workspace/run-files.ts`), and nothing when the folder is the home folder or an agent's own skill folder, or the turn is read-only (`accessMode` `review`). `.ensemble/skills.json` (`ensemble.skills.v1`) records, per skill folder, the folders Ensemble wrote and the SHA-256 of each `SKILL.md` it wrote. Only those are rewritten, and removed once no longer given, and only while they hold nothing but that `SKILL.md` with that hash (`asLeft`); with no record at all, a folder with Ensemble's mark in its frontmatter (`ensemble.source`) counts as written by it. A folder git tracks a file in (`git ls-files` there; when git cannot tell, no folder that is there is changed), a link, and any other folder are left as they are, and a skill whose name they hold is not given. A turn whose skills did not change writes nothing. A turn that wrote no folder (read-only, nothing to do there, or a failure, logged) reports the skills as the session last had them (`skills: "unchanged"` in `buildPacket`), never as gone. `excludeInGit` adds each written folder, `/<folder>/<name>/`, and the record (under the run folder's path in its repository) to the repository's `info/exclude`, a worktree's common one included.
- **Limits.** A run's minutes and turns are the owner's (`runLimits` in `packages/shared-types/src/assistant.ts`, used by `createJob` and the Assign dialog): none unless set. Saved settings carry Ensemble's old defaults, 60 minutes and 40 turns, whether or not the owner chose them, and are still saved with them, since an older API (during a deploy) refuses null there, falls back to its defaults and would save those over the owner's settings. So a saved 60 or 40 reads as no limit unless the owner set it in Settings, Task limits (`orchestration.ownLimits`); a limit the owner clears is saved as null. Run again keeps a run's own limits; a run that had none gets the owner's limits as they are then (`repeatAssignment`).
- **On a paired computer.** The claim sends `chat` and `surface`, for a folder the web's `context.codeFolder` (`devices/routes.ts`), which `deviceAssignment` offers only to a computer with `capabilities.codeAgent` 1 (`deviceCodesWithAgent`; the refusal names the computer's version), the packet's facts as the web has them (`packet`, from `packetSource`, in place of the task brief's context), `profileInstructions` and `fork` (a fork only to a computer with `capabilities.codeAgent` 2, `deviceForksCodeThreads`). The computer builds the packet, writes the skills and the handoff record, and runs the checks again; its `complete` sends `codeTurn` (`CodeTurnResult`: the completion, the packet without its hashes, the skills and the handoff record), which the web keeps on its own run and in `session_handoffs` with its own ids (`keepCodeTurnResult`). The computer plans it as a chat turn (`planLocalJob`): in a folder only with *Change code from the web* on and only in a repository the Code API may open there (`codeFolderHere` in `remote/accept.ts`, `codeRepoRoots` in `lib/code-folders.ts`); with none, in a new folder of its workspace. Later turns of a thread go on its first turn's local task, a fork's on a new one. A computer without the capability runs a thread with no folder as a task run that continues its session.

### 6. Speed

- The review list comes from the database, with each review's file and line counts from git (cached 8 s).
- A file's four versions load in one call when its tab opens (`GET /api/code/versions`) and stay in the page's query cache; progress counts are cached per file until the file or its accepted text changes.
- CodeMirror, the merge view and language parsers load only on `/code/review`.
