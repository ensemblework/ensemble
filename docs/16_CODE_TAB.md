# 16 · The Code tab — review, rewrite, commit (and a guarded terminal)

The **Code** item in the sidebar lists every run that changed files. Opening one gives an IDE-like review of exactly what the agent changed, hunk by hunk, and the tools to finish the job without leaving Ensemble: accept or reject a change, edit anything yourself right there, look at the whole file, commit, push, open a pull request, or use a small terminal for git.

**Hosted public accounts:** host folders, repository filesystem operations and shell execution are operator-only (`lib/hosted-access.ts`). `ENSEMBLE_TERMINAL=off` overrides user settings; hosted production defaults to off even for operators. Notes/context and assigning to a user's paired device remain separate. Desktop/local Code behavior is unchanged.

Failed review/repository queries display the actual error and Retry; they never claim that no work exists. A denied terminal-status request settles into an error instead of “Opening the terminal…”. Hosted guidance points to a paired computer for local execution/review, not a way to obtain host privileges (`app/(hub)/code/page.tsx`, `components/code/terminal.tsx`).

---

## 1. Using it

| You want to… | Do this |
|---|---|
| See what a run changed | Code → click the run (or *Review code* on the run / task page) |
| Keep an agent change | *Accept* on it, or Alt+Y with the cursor in it. Nothing on disk changes — it is already there |
| Undo an agent change | *Reject*, or Alt+N. The old lines go back on disk; Ctrl+Z (or *Undo* on the note) brings the change back |
| Change something yourself | Just type, in either view. Your edits show in **blue** with *Revert* (Alt+N) |
| Put a file back as the run left it | *Restore the run's version* in the file bar (drops your edits and rejects in that file) |
| Read / edit the whole file | *File*, or F4 — folding, change bars in the gutter, same document as the Changes view |
| Move around | F7 / Shift+F7 next/previous change (crosses files), Alt+→ / Alt+← next/previous file |
| Find / replace | Ctrl+F |
| Focus | Full screen button (Esc leaves), Ctrl+B explorer, `?` shortcuts (outside the editor) |
| Resize the explorer | Drag its right edge (up to half the width; double-click resets; arrow keys when focused) |
| Code text size | Zoom buttons, or Ctrl+Shift+= / Ctrl+Shift+- / Ctrl+Shift+0 (10–24 px, editor and terminal only) |
| Commit / push / PR | Source control at the bottom of the explorer |
| Run git yourself | Terminal button or Ctrl+` |

It is an **editor first**. Type anywhere — in the Changes view or the whole-file view — and it is saved automatically (0.7 s after you stop, on Ctrl+S, when you switch file or view, and before a commit). The status bar shows `• Unsaved` → `Saving…` → `Saved`.

**No shortcut is a bare letter or an editing key:** Ctrl+Backspace deletes a word, Ctrl+Enter is left to the editor, and every letter types.

### Folders Code can use

The Code tab has its own folder list, **Settings → Folders Code can use** (`settings.code.roots`). It is separate from the terminal's list (`settings.terminal.roots`, §5): the terminal never reads Code's list, and Code never reads the terminal's (`apps/hub-api/src/lib/code-folders.ts`).

- A folder is checked when it is added (`POST /api/code/folders/resolve`, and again when Settings saves): no `..`, no system folder, no dotfile or dot-folder in your home folder, and no link that leads out of home. It is stored as its real path. The desktop app offers the native folder picker.
- Every saved folder is checked again each time Code uses it, so a folder later swapped for a link is skipped.
- On the first start after the split, a settings row with no `code` section gets a copy of the terminal's folders, once. Removing every Code folder stores an empty list, so they do not come back.
- `PUT /api/preferences` no longer accepts the `hub.settings` key. Settings are saved through `PATCH /api/settings`, which runs these checks.

### What the Changes view shows

The diff is the file **now** against **before the run**, plus the agent changes you accepted. So it always shows what is still worth looking at:

- **Green / red** with *Accept · Reject* — an agent change, exactly as the agent made it, not decided yet.
- **Blue** with *"Your edit" · Revert* — anything else that differs: lines you added, or an agent change you typed over (made here, in VS Code, or in the terminal — git cannot tell who typed, so anything that is not *exactly* the agent's is shown as yours). Your edits never need reviewing.
- Accepted changes and rejected ones **disappear from the diff**; a file with nothing left shows *Reviewed — edit freely* and is not folded.

Whether an agent change is decided is read from the **text itself**: type over it and it counts as edited; reject it and it is rejected; Ctrl+Z either, and it is pending again.

Progress shows as *"17 / 23 — 2 files left"*, a ring per file, and a badge in the list.

If something else writes the file while you have unsaved typing (VS Code, the terminal), **nothing is overwritten silently**: a bar offers *Keep mine (overwrite)* or *Use the version on disk*, and your text stays on screen until you choose.

The editor follows Ensemble's theme; the moon button keeps it **dark regardless**. Code is always in a coding font (Cascadia Code → Consolas, ligatures off) at its own size, whatever font and text size *Settings → Appearance* sets for the rest of Ensemble.

---

## 2. What a run is answerable for

Every run records **two snapshots** of its folder as git trees, using a throwaway index so your real staging area is never touched:

- **start** — the folder as the job found it: committed, staged, unstaged and never-added files alike;
- **end** — as the job left it.

Both are pinned as `refs/ensemble/review/<job>/{start,end}` for **14 days**, so git's own garbage collection cannot take them; a daily sweep drops them after that.

The review is start → end, so work you had **before** the run (your `plan.md`, your own edits) is never shown as the agent's. It is listed separately as *Yours, before the run*. Git-ignored files have no snapshot; if a run changed any, they are listed as *Changed, can't be reviewed*.

Runs from before snapshots existed are reviewed against the commit they started from, with a banner saying so.

### A failed or stopped run leaves nothing behind

When a run fails or you stop it (or reject its publishing), its folder is put back to the **start snapshot**. Only the files the agent itself changed are touched (each file-changing tool call is attributed); a file you changed meanwhile is left alone; and nothing is moved if the run had already committed. What it tried stays reviewable, with *Restore its changes* to put it back.

A **blocked** run (turn limit, needs information) keeps its work — *"progress is saved"* — and the next attempt continues from it and is reviewable like any other.

### Line endings

The host may have `core.autocrlf=true` in the system git config, which Ensemble's isolated git does not read. For the engineer's own folders Ensemble **reads that one setting the way their git sees it**, so CRLF working files are not mistaken for changes, snapshots store what their git would store, and a commit does not rewrite every line. The Code tab diffs LF text and every write puts the file's own line endings, BOM and final newline back.

---

## 3. Commit, push, pull request

The Source control panel groups files exactly like the review: **changes from this run (ticked)** and **your changes from before the run (not ticked)**, so `plan.md` stays out unless you tick it. Subject (with the 50/72 counter), Markdown description with *Write | Preview* (GitHub-flavoured: tables, task lists), `Co-authored-by: Copilot` when agent changes are included, and a pull request section (title, description prefilled from the repository template or the agent's proposal, base branch, draft). Drafts are kept per run.

The commit is built from **exactly the ticked paths** in a throwaway index — nothing else you had staged rides along — with hooks off. Pushing uses your GitHub sign-in for `github.com` remotes (**https only**), and asks before pushing straight to the default branch. Committing with unreviewed changes asks inline first.

---

## 4. Which branch the agent works on

The assign dialog's *Optional information* has *Which branch the agent works on*:

- **Use as is (default)** — nothing is created or switched. Your own folder is worked on exactly as it is; Ensemble's checkout uses the branch picked below or the default.
- **Existing branch** — Ensemble's checkout works directly on the branch you pick, for a pull request too (opened from that branch; **never the default branch**).
- **New branch** — create and switch to the name you give before starting. In your own folder that is `git switch -c`, carrying uncommitted work over.

---

## 5. The terminal — for you only

A small terminal docked under the editor, for the jobs that otherwise send you to a shell: make or switch a branch before assigning, commit and push after reviewing.

**It is not a shell:**

- **Who** — it needs a **passkey** (Windows Hello PIN, face or fingerprint) once per session: 30 minutes idle, 8 hours at most. No agent, MCP call or script in Ensemble can produce one, and Ensemble's own service token is refused outright. The same session covers commit/push in the Source control panel.
- **What** — an allow-list: `git` (hardened: hooks pointed at an emptied folder of Ensemble's own, no `-c` overrides, no exec transports, `--force` refused in favour of `--force-with-lease`, history rewrites and deletions confirmed by typing the branch name or `yes`), `uv`, `python --version` / `-m venv` / `-m pip list`, and built-ins (`cd`, `ls`, `cat`, `head`, `tail`, `find`, `grep`, `mkdir`, `cp`, `mv`, `rm`, `tree`, `pwd`, `which`, `env`, `activate`, `history`, `clear`, `help`). Everything else is refused with a reason. **No PowerShell, no cmd, no network tools, no running repository code.**
- **Where** — originally `C:\Users\t-sharmaak\ensemble-workspace` and `C:\Users\t-sharmaak\work`, plus folders you add in *Settings → Terminal and commits* (which asks for the passkey). Nothing above them. Windows, Program Files, ProgramData and credential folders are refused whatever you add.
- **Record** — the ledger records that a command ran (arguments, folder, exit code); **never what it printed**. Output is never stored, indexed or shown to a model. If a run changed a folder's `.git/config` since you last looked, git commands that change anything wait until you trust it.

Settings can turn the terminal off, or **off through the tunnel only**.

### Passkeys and addresses

A passkey belongs to the **site it was made on** and stays on the **computer that made it** (in its TPM). Localhost first: register at `http://localhost:3100` (or whatever port we ship), not `127.0.0.1` — browsers refuse passkeys on a raw IP. The PIN never reaches Ensemble; it only unlocks the passkey on that device. Every passkey is listed (and removable) in Settings.

---

## 6. Speed

- The list is **database-only**. Hovering a run starts loading its review.
- File contents are fetched once by blob SHA — **immutable**, so cached forever and never invalidated: memory (~48 MB LRU), this device's IndexedDB (150 MB cap or 10% of quota; reference-counted per review, expired reviews and unreferenced blobs swept hourly, never the open review), and the browser's HTTP cache. *Keep reviewed code on this device* is **off by default through the tunnel**; *Clear* is in Settings.
- One editor, one prebuilt state per file (neighbours built at idle), swapped on back/next: no re-highlighting, no teardown.
- Manifests revalidate with ETag (a 304 when nothing changed); blob and manifest responses are brotli-compressed.
- CodeMirror, the diff and each language parser load only on `/code/*`.

---

## 7. Not in this version

- Side-by-side view and a change overview on the scrollbar (the unified view and the gutter cover the same ground).
- Autocomplete / IntelliSense, go-to-definition and formatting — this is a review-and-edit surface with syntax highlighting, brackets, indentation, multi-cursor and find/replace, **not a language server**.
- Files over **1 MB** are shown whole and read-only, with keep / put back.
- Terminal: package installs that run package code beyond `uv sync` / `add` / `remove` (confirmed), conda, a separate broker process and Windows Job Objects.
- Web Worker diffing for very large runs.

---

## 8. Residual risks, said plainly

- **Native-mode agents run as you.** The terminal adds nothing they can reach, but the OS does not separate them from your account — sandbox mode is the real boundary.
- A process running as you could register a passkey before you do. Every registration is in the ledger and listed in Settings, so an unexpected one is visible and removable.
- Allowed programs are powerful by design: `git` follows repository config (hardened, not eliminated), and `uv sync` runs package code (hence the confirmation).
