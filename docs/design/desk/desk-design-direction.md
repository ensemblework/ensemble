# Desk design direction: high-fidelity mockups before any more building

## Why
Prajwal rejected the marketplace visuals. Today tiles were huge boxes with one row each, the Context widgets were empty, and everything looked like "a simple HTML/CSS list". His words: "Please have a good UI UX, don't just have templates for the sake of it. Pour in your imagination, design some good templates and design."
His standing taste: a rich, board-style, distinctive UI that is better than Notion, with no "AI chat app" feel, subtle modern effects, dark by default, and speed that matters as much as looks. He dislikes bare lists.
Examples of the failure: /workspace/ensemble/screenshots/marketplace/today-chambers-1440.png and context-widgets-chambers-1440.png.

## Your job
Design the result and render it as high-fidelity static mockups. Don't touch the product code and don't push anything. This is a design phase, and a cloud agent will build it later to match your mockups.

1. Study the real app for fidelity. Read the repo at /workspace/ensemble/repo (branch feature-2) for its design tokens, fonts, colours, radius and spacing (hub-web globals, the tailwind config, the theme and accent files). Look at the running app at http://localhost:3000 (local test login, credentials not committed; read-only, don't change his data) and the screenshots under /workspace/ensemble/screenshots/. Keep the app's identity (warm dark, serif display headings, the accent system), then push it far beyond the current state.
2. Build the mockups as a standalone project in /workspace/ensemble/mockups. Use Vite with React and TypeScript, or plain HTML with CSS. Use the same fonts and tokens, hand-written SVG micro-charts and no chart library, and realistic, specific sample data. No lorem ipsum, and no "Filing / Filing / Limitation" repeats. Use en-IN dates, Indian names where natural, and plausible content for each persona.
3. Render them with Playwright to PNG at 1440x900 (plus full-page) and at 390 wide, into /workspace/ensemble/mockups/out/. Check every image yourself by eye and iterate until it's genuinely beautiful. Critique it like a design lead at Linear or Arc would.

## Principles (the non-negotiables)
- A tile is never taller than its content. Use a 12-column bento grid, fixed tile heights per size (S, M, L, XL), and mixed spans. There must be no big empty tile anywhere.
- Every widget has a signature visual, not just rows. Use big serif numerals, rings, sparklines, bands, heat grids, timelines, stacked bars, avatars and chips.
- Each widget has 3 designed states: a skeleton that matches its final shape; empty, shown as a ghosted, dimmed preview of what it will look like, with one clear action ("Add your first hearing" or "Try with sample data"); and populated. Mock all three for at least 4 widgets.
- Widget anatomy: an icon and title, a quiet meta count, and a hover action (open, or add). A tile carries the template accent as a thin top glow or edge, never loud fills. Use a 1px inner highlight border, subtle grain or gradient depth, and a hover lift of 1–2px.
- Motion (describe it in the spec; show it with a static annotation): numerals count up, rings draw on mount, lists stagger at 20ms, and reduced motion is respected. All of it is cheap CSS.
- Density: at least 3 meaningful items per list tile, or it becomes a compact stat tile.
- Every Today has a hero at the top spanning 8–12 columns, the one thing that persona cares about most.

## Templates: fewer, deeper, each with a reason to exist
Replace "9 templates for the sake of it" with 8 persona desks. Each desk must have a clear point of view and a signature hero. You may merge, rename, cut or add if a better idea emerges, but justify it.
1. Student, Semester: the hero is a week strip (Mon to Sun) with classes and deadlines on it. It also has per-course progress rings, an assignment deadline rail and a study streak heat grid.
2. Aspirant, exam season (merge Exam sprint and Prelims): the hero is a countdown with a huge numeral and a ring. It also has a syllabus coverage map by subject (a treemap or segmented bars), a mock score trend with a target line, a revision queue due today and a daily hours heat grid.
3. Researcher, Literature desk: the hero is a reading pipeline (To read, Reading, Notes, Cited) of mini paper cards showing venue and year. It also has draft word-count progress toward a goal, a small citation graph and a weekly reading streak.
4. Legal, Chambers: the hero is a limitation and deadline band, a horizontal 60-day timeline with red, amber and calm zones and pinned matters. It also has hearings this week (a calendar strip), matters by stage and billable time against a target.
5. Teacher, This week's classes: the hero is today's timetable with the current period highlighted and the next one. It also has a grading queue by class with counts, syllabus progress per class and student follow-ups.
6. Manager, Staff week: the hero is team load (avatars with capacity bars). It also has 1:1 cadence dots with "last met", objectives with progress, a decision log and blockers.
7. Developer, Branch desk: the hero is pull requests needing you, with CI dots and review state. It also has a branch activity sparkline, a deploy timeline and assigned issues.
8. Maker, non-dev engineer, Bench: the hero is a build milestone timeline (a mini Gantt). It also has a parts or BOM checklist with progress, a test results pass/fail grid and a build log.
Plus Default: the owner's general desk, which also needs to look rich.

## Deliverables (mockups)
- A. The widget kit sheet: every widget above, grouped by persona, populated. Plus the 3-state sheet (skeleton, empty-ghost, populated) for 4 widgets.
- B. Today for each of the 8 desks plus Default at 1440, with realistic data. Do 3 of them at 390 as well.
- C. A new-user Today for 2 desks right after apply: the empty-ghost states plus a "Try with sample data" banner. It must still look intentional and beautiful, never empty.
- D. The Context overview for 2 desks. It must never be an empty card: people with avatars and roles, artifacts with type icons, and lens-specific tiles.
- E. The marketplace gallery at 1440 and 390. Cards show a miniature of the real desk mockup (scaled) in the template accent, with persona filter chips, search, and a featured hero row.
- F. The template detail: a large preview, what you get (the widgets, lanes and labels), what changes (a diff against your current desk), and Apply.
- G. The apply moment: the desk rearranging, then a toast reading "You're on Chambers · Undo".
- A short spec at /workspace/ensemble/mockups/SPEC.md covering the tokens used, tile sizes and grid, widget anatomy, the states, the motion, each desk's widgets and data needs (which existing data they read, and any new fields), and the perf budget: SVG and CSS only, no new chart dependency, and each desk's widgets code-split.

## Report back
The list of PNG paths with one-line captions, your honest self-critique, the template decisions (what you merged or cut and why), and anything the data model lacks for these widgets.
