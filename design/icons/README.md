# Ensemble icons

Source: the `ensemblework/ensemble` repo on GitHub (main @ 3edc90b). I read it through the GitHub connector and changed nothing in the repo. I also used the notes in /workspace/ensemble-notes.

## Palette (from apps/hub-web/app/globals.css)
| Token | Dark | Light | Where it's used here |
|---|---|---|---|
| bg | #141210 | #f4f1ea | bottom of the tile gradient; sheet backgrounds |
| raised | #2b261f | #f7f3ec | top of the tile gradient |
| ink | #f3eee6 | #1c1915 | the "you" strand/card/node |
| accent | #7c6af7 (hover #917ff8) | #5346d6 | the "agent" strand; active nav icon |
| lavender tint | #9d8fff / #b4a9ff | | accent highlights (tints of the accent) |

## App icon
- `app-icon/svg/ensemble-*.svg`: the macOS master. 1024 canvas, 824 tile at a 100px inset, rx 185, soft shadow.
- `app-icon/svg/ensemble-*-fullbleed.svg`: the same art cropped to the tile with no shadow. Use it for Windows, Linux and the favicon.
- `app-icon/svg/ensemble-b-two-voices-symbolic.svg`: a single-colour `currentColor` mark for the menu bar or tray.
- `app-icon/png/recommended/`: B at 16 to 1024 px (macOS and full-bleed), plus `ensemble.ico` (16 to 256) and `ensemble.icns`.

## UI icons (`ui-icons/svg`)
- 24×24 grid, 1.75 stroke, round caps and joins, `fill="none"`, `stroke="currentColor"`.
- A few small dots (today marker, agent eyes, drag grip, brand nodes) use `fill="currentColor"`.
- They drop into the existing `lucide-react` slots:

| Ensemble | replaces lucide | | Ensemble | replaces lucide |
|---|---|---|---|---|
| today | CalendarDays | | menu | Menu |
| board | Columns3 | | search | (Jump to… / palette) |
| needs-me | CircleCheck | | ask | (Ask Ensemble bar) |
| runs | Activity | | notifications | Bell |
| context | Users | | undo / redo | Undo2 / Redo2 |
| skills | BookOpen | | fetch | RefreshCw |
| workspace | Briefcase | | peek-panel | PanelRight |
| code | Code2 | | theme-light / theme-dark | Sun / Moon |
| metrics | BarChart3 | | agent / you | Bot / UserRound |
| meetings | CalendarCheck | | pause / resume / stop | Pause / Play / Square |
| recap | ListChecks | | stop-all | OctagonX |
| completed | ListChecks (dup) | | add / close / approve | Plus / X / Check |
| trash | Archive | | chevron-right, open-external, copy | ChevronRight, ExternalLink, Copy |
| connect | Cable / Plug | | terminal, branch, drag | TerminalSquare, GitBranch, GripVertical |
| settings | Settings | | ensemble | components/mark.tsx |

## Rebuild
```
python3 -m venv .venv && .venv/bin/pip install cairosvg pillow
.venv/bin/python src/app_icons.py && .venv/bin/python src/export.py && .venv/bin/python src/sheet_app.py ensemble-b-two-voices
.venv/bin/python src/ui_icons.py && .venv/bin/python src/sheet_ui.py
```
