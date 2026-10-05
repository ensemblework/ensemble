# Desk design

The design work for the Today desk: widgets, persona desks, the template gallery, and the apply flow.

| Path | What |
|---|---|
| [SPEC.md](SPEC.md) | Desk spec: tokens, grid and tile sizes, widget anatomy, the three states, motion, each desk's widgets and data needs, and the perf budget |
| [desk-design-direction.md](desk-design-direction.md) | The design brief the mockups answer |
| [desk-build.md](desk-build.md) | The build brief for turning the mockups into hub-web code |
| [research-main-d2e73f6.md](research-main-d2e73f6.md) | Research on `main` at d2e73f6: block diagrams, nav, templates and flags, brand tokens, overlap with feature-2, drift from SPEC.md |
| [mockups/](mockups/) | Mockup source (Vite + React + TypeScript). `npm install`, then `./build-all.sh` renders every screen into `out/` |
| `renders/` | Rendered mockups. Not kept in the repo; `mockups/build-all.sh` renders them again. |

## Renders

File names are `<section>-<screen>-<width>[-full].png`. `-full` is the whole page; without it, the image is the first viewport.

- **A**: widget kit (A1) and the three widget states (A2)
- **B**: Today desks for each persona template (default, chambers, classes, exam, literature, semester, staff, bench, branch), at 1440 and some at 390
- **C**: new-user desks
- **D**: Context
- **E**: template gallery
- **F**: template detail
- **G**: apply flow (rearranging, then the toast)
- **H**: before/after sheet against the live app
- **X**: plot tile settings and widget gallery

`ref/peek.mjs` screenshots the local app and reads the login from `ENSEMBLE_EMAIL` and `ENSEMBLE_PASSWORD`.
