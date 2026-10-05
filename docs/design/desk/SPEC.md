# Ensemble Desk: design spec (mockup phase)

This spec goes with the PNGs in `out/`. Source is in `src/` (Vite + React + TS). Run `./build-all.sh` to rebuild every PNG. Everything here is design intent. The product repo is untouched.

## 1. Tokens
It keeps the app's warm dark identity (`apps/hub-web/app/globals.css`) and adds one desk layer on top.

| Group | Tokens |
|---|---|
| Surfaces | `--bg #141210`, `--sidebar #1b1815`, `--panel #221e1a`, `--raised #2b261f`, **new** `--tile #1e1a16`, `--tile-top rgba(255,248,236,.03)` |
| Ink | `--ink #f3eee6`, `--ink-2 #ddd5c8`, `--muted #b7ae9f`, `--faint #8f877b`, `--ghost #5f584f` |
| Lines | `--line` 8%, `--line-strong` 14% (warm white) |
| Status | `--ok #3cba86`, `--warn #e0a04a`, `--danger #e36b64`, each with an `-rgb` twin for alpha |
| Accent | `--a` and `--a-rgb`, set once per desk on the shell. Desk accents: indigo `#7c6af7` (Default, Branch), orchid `#cf9cf2` (Semester), rose `#f0a0b8` (Exam season), brass `#e4c56e` (Chambers), moss `#a9cc7e` (Classes), ember `#f0a36a` (Staff week), tide `#5dcec6` (Literature), sky `#82b3f5` (Bench). They map onto the existing `lib/accent.ts` presets and custom-hex path. |
| Type | Figtree for UI; Fraunces for display and **all hero numerals** (`.num`, tabular, `opsz` high, weight 500); JetBrains Mono for ids, times and code refs; `.cap` 10.5px/600/0.08em caps for axis labels |
| Radius | `--r-tile 14px`, `--r-inner 9px`, chips 999px |
| Motion | `--ease cubic-bezier(.2,.8,.2,1)`, `--dur-fast 120ms`, `--dur 180ms` |
| Grid | `--row 72px`, `--gap 12px` |

Light theme: same structure. `--tile` becomes `#fffdf9`, grain opacity is halved, and accents use the darker `lib/accent.ts` light variants. It was not mocked this round.

## 2. Grid and tile sizes
- 12-column bento. Rows are a fixed `72px` with a `12px` gap, and `grid-auto-flow: dense`, so a smaller tile back-fills a gap.
- Heights are fixed per size. **A tile is never taller than its content.** If the content doesn't fill the size, the widget steps down a size. It is never stretched.

| Size | Rows | Height | Typical spans | Use |
|---|---|---|---|---|
| S | 2 | 156px | 2–3 cols | a compact stat: one numeral plus one micro-visual |
| M | 3 | 240px | 3–6 cols | a signature visual plus 3–5 rows |
| L | 4 | 324px | 4–6 cols | a list of 5–7 rows, or a chart with a legend |
| XL | 4–5 | 324–408px | 8–12 cols | the hero only |

- Every Today starts with a hero spanning 8–12 columns. Rows are packed so each band sums to 12 columns. No orphan gaps at 1440 (checked on every desk PNG).
- 390px: 4 columns. The hero spans 4. S tiles pair at 2+2. Heroes get a dedicated compact layout rather than a squeeze (see `LimitationMobile` and the `mobile` variants of Countdown, PR queue and CI).
- These sizes match `WIDGET_REGISTRY` sizes S/M/L/XL and `ROW_PX` in `shared-types/src/widgets.ts`. Only the row pitch changes (72px), and `spanFor` gains the 2- and 3-column S spans.

## 3. Widget anatomy
Parts, top to bottom:
1. **Header** (28px): a 22px icon well tinted with the accent at 14%, the title (13px/600), a meta count (12px faint, e.g. "7 matters · Limitation Act, 1963"), and a right slot (a filter chip or a live dot). The hover action (`⋯` and a size toggle) fades in at the right on hover only.
2. **Signature visual first**: numeral, ring, band, sparkline, heat grid, treemap or Gantt. Every widget has one. A plain list is never the whole tile.
3. **Rows**: 3 or more meaningful items, each carrying one colour-coded fact (days left, a CI dot, a score).
4. **Surface**:
   - `--tile` plus a top-left radial accent glow at 5.5%, and a 42% top sheen.
   - A 1px border at 7%, and a 1px inner top highlight (`inset 0 1px 0 rgba(255,255,255,.045)`).
   - A soft drop shadow, and an SVG grain overlay at 3.5% (a data-URI, no request).
5. **Hover**: `translateY(-1.5px)`, border to 14%, shadow deepens, over 120ms.
6. **Hero**: accent glow at 10%, a 1px accent hairline along the top edge, and numerals at 64–96px.

## 4. States (sheet A2)
Each tile keeps its footprint in all three states, so the layout doesn't shift (CLS stays near 0).
- **Skeleton**: the final layout in outline (numeral block, ring circle, row bars) using `--raised` blocks. A 1.4s shimmer, which is off under reduced motion. It renders from layout data before any widget data arrives.
- **Empty (ghost)**: the *populated* widget with realistic sample shapes, at 22% opacity and 0.2 saturation, masked toward the bottom. On top sits a one-line promise, one sentence of why, and exactly **one** action pill. The tile never collapses.
- **Populated**: real data, with the signature visual first.
- New-user Today shows every tile in ghost, plus a "Try with sample data" banner with 3 next steps (see C-*.png).

## 5. Motion (CSS only; annotated in A2 and G-apply)
- **Tiles rise in**: opacity and `translateY(6px→0)`, 240ms, 20ms stagger (an `--i` custom property per tile).
- **Rings draw**: `stroke-dashoffset` from full to the value, 700ms ease-out.
- **Numerals count up**: `@property --n { syntax: '<integer>' }` animated 0→value over 600ms and rendered with `counter(n)`. Tabular figures, so there is no reflow. No JS.
- **Lists**: rows stagger 20ms apart (opacity + 4px). At most 8 rows animate.
- **Sparklines**: `stroke-dasharray` path reveal over 500ms, then the end dot pops.
- **Apply moment** (G-apply-1/2):
  1. Old tiles fade over 120ms, with a dashed outline where each one was.
  2. The accent crossfades over 240ms (`--a` via `@property <color>`).
  3. New tiles FLIP into their slots (transform only) over 320ms with a 20ms stagger.
  4. Numerals and rings run after the tiles land.
  5. The sidebar relabels (Board → Matters) and gated items fold away.
  6. The toast "You're on Chambers · Undo" has `role="status"` and a 6s timeout that pauses on hover.
- **Reduced motion**: `prefers-reduced-motion` or the in-app setting skips every track and paints the final frame at once.
- **Rules**: transform and opacity only, no layout animation, and only one IntersectionObserver per desk to start the tracks once visible.

## 6. Desks: widgets and data needs
Legend: **reads** means existing tables and fields. **new** means a field or source that doesn't exist yet. `Task.taskType` and `Task.measure` (minutes or a score) already exist, and many widgets lean on them.

### Default: Your desk (indigo)
- Hero **Your day** (8×4): a two-lane timeline, calendar vs focus blocks, with a now line. Reads `Artifact(kind=event)`, `Task.due`, `todayFocus`.
- Other tiles:
  - **Needs me**: `Task.status in (waiting_approval, blocked)` and `Approval`.
  - **Morning brief**: the existing brief.
  - **Focus**: `todayFocus` and `priority`.
  - **Proposals**: `status=proposed`, `confidence`.
  - **Deliverables**: `Deliverable.due`, status.
  - **People**: `Person.lastInteraction`, `relationshipWeight`.
  - **Reminders**: `Reminder`.
- New: none.

### Semester: Student (orchid)
- Hero **This week** (12×4): Mon–Sun with timed class blocks, deadline pins per day and a now line.
- Other tiles:
  - **Deadlines** rail: days-left numerals and a source badge (Moodle).
  - **Courses**: a progress ring per course plus attendance vs the 75% rule.
  - **Study streak**: a 12-week heat grid.
  - **In class now**: now and next.
  - **Study plan**: timed checklist.
  - **Mini-project**: share per member.
  - **Reading**: chapter and page progress.
- Reads: `Project` = course, `Task.due/status`, `Task.measure` (study minutes, `taskType=study`), `Artifact(kind=email)` for Moodle pins, `ProjectPerson`.
- New: a **recurring class schedule** (a weekly slot: day, start, end, room, course), **attendance counts** per course (held/attended), a course **credits/code** field, and a page count (`total`/`current`) for readings.

### Exam season: Aspirant (rose). Exam sprint and Prelims merged.
- Hero **Countdown** (8×4): a huge day numeral, a syllabus ring (a different metric from the numeral, which avoids N7), and phase segments (Foundation → Revision → Mocks).
- Other tiles:
  - **Daily target**: hours ring.
  - **Current affairs**: streak.
  - **Syllabus map**: a treemap by subject, area = weight, fill = covered.
  - **Mock trend**: sparkline, target line and cut-off band.
  - **Revision queue**: due today, spaced-repetition interval.
  - **Hours heat**: 16 weeks.
  - **PYQ accuracy**: by subject.
- Reads: `Project` = subject, `Task.measure` (minutes, or a score for `taskType=mock|pyq`), `Task.due` for the revision queue, `Deliverable` = exam date.
- New: an **exam date + phases** config on the desk, a subject **weight** and topic count, **max score/cut-off** per mock series, and a revision interval (`nextReviewAt`, `ease`) on tasks.

### Literature desk: Researcher (tide)
- Hero **Reading pipeline** (12×4): four lanes (To read, Reading, Notes, Cited). Each mini paper card shows venue, year, authors and a progress tick.
- Other tiles:
  - **Draft**: words toward a goal, with a per-chapter bar.
  - **Citation graph**: a small force-free SVG with fixed positions.
  - **Reading streak**: weekly.
  - **Open questions**.
  - **Advisor**: next meeting and last notes.
  - **Venues**: deadlines.
- Reads: `Artifact(kind=file)` + `Document` for PDFs, `MeetingNote` for the advisor, `Task` for the questions, `Person` for co-authors.
- New: **paper metadata** (DOI, venue, year, authors) in `Artifact.metadata`, a **pipeline stage** per paper (it could reuse Context groups), **cites edges** between papers, and a draft word-count source (a doc link or manual `measure`).

### Chambers: Legal (brass)
- Hero **Limitation band** (12×4):
  - A 60-day horizontal band with red (≤7d), amber (≤21d) and calm zones, pinned matters, holiday hatching, and red/amber/calm counters.
  - The lead matter carries the computed rule, e.g. "Day 30 is Gandhi Jayanti, so s.4 carries it to Monday."
- Other tiles:
  - **Hearings this week**: a calendar strip, with court holidays shown.
  - **Billable**: ring vs 40h, plus daily bars.
  - **Matters by stage**: stacked bar.
  - **Filings due**.
  - **Draft pair**: two paper previews.
  - **Cause list live**: item number and court.
  - **Unbilled**: ₹.
  - **Focus** and **Follow-ups**.
- Reads: `Project` = matter, `Deliverable` = filing (the label "Filing"), `Task.measure` minutes with `taskType=time`, `Artifact(kind=event)` for hearings, `Person` = clients and clerks.
- New:
  - matter **stage** and **forum/court**
  - **order date + limitation rule**, so the date is computed rather than typed
  - a **court holiday calendar**
  - **cause-list item and court number** from a feed
  - an **hourly rate** for Unbilled

### This week's classes: Teacher (moss)
- Hero **Today's timetable** (12×4):
  - The day as a ribbon of periods, with the current period highlighted: "20 min left", class, room and topic.
  - Next period and room. Free periods are hatched.
- Other tiles:
  - **Grading queue**: by class, with counts and oldest.
  - **Syllabus per class**: progress bars and the planned-by line.
  - **Student follow-ups**: avatars and reasons.
  - **Attendance today**.
  - **PTM**.
  - **Duty roster**.
  - **Next test**.
- Reads: `Project` = class/section, `Task` for marking and follow-ups, `Person` = students or parents, `Artifact(kind=event)`.
- New: the **recurring timetable** (the same model as the student schedule), **submission counts** (expected vs marked) per assignment, per-class **syllabus units**, and attendance per session.

### Staff week: Manager (ember)
- Hero **Team load** (8×4): an avatar row with capacity bars (tasks and points vs capacity), overload in red, and out-of-office hatched.
- Other tiles:
  - **Blockers**: age in days.
  - **1:1 cadence**: dots for the last 6 weeks, "last met".
  - **Objectives**: progress, with a confidence dot.
  - **Decision log**.
  - **Who's out**.
- Reads: `Person`, `Task.people`/`owner`, `MeetingNote` + `Artifact(kind=event)` for 1:1s, `Deliverable` = objective, `AgentDecision`/`Task(taskType=decision)`.
- New: per-person **weekly capacity**, **leave/OOO** dates, a 1:1 **cadence target** (e.g. every 14 days), and objective **progress %** (today `Deliverable` has only upcoming/completed).

### Branch desk: Developer (indigo)
- Hero **Pull requests needing you** (8×4): the count numeral, each PR with a CI dot strip (the last 5 checks), review state, age and a size (+/−).
- Other tiles:
  - **Branch activity**: a 14-day commit sparkline.
  - **CI health**: pass-rate ring and flaky tests.
  - **Deploys**: prod, staging and preview lanes with versions.
  - **Assigned issues**: priority bars and estimate.
  - **In progress**: WIP cap segments.
  - **Blocked**.
  - **Done this week**.
- Reads: `Artifact(kind=pr|commit|issue|pr_comment)`, `Repo`, `CodeReview`, `Task(sourceKind=github|linear)`.
- New: **check-run status** per PR (it can live in `Artifact.metadata`), **deploy events** per environment (a new artifact kind `deploy`, or a webhook), and a WIP cap preference.

### Bench: Maker, non-dev engineer (sky)
- Hero **Build timeline** (12×4): a mini Gantt of milestones (EVT → DVT → PVT) with task bars, dependencies, a today line and slip markers.
- Other tiles:
  - **BOM**: a ring of parts in hand, with long-lead parts flagged.
  - **Test results**: a pass/fail grid, board × test.
  - **Build log**: timestamped entries with photos.
  - **Budget**: ₹ spent vs cap.
  - **Lead time**: supplier days.
  - **Current draw**: sparkline vs spec.
  - **Next milestone**.
- Reads: `Deliverable` = milestone, `Task` (+ `due`, and a start date via `createdAt` today), `Artifact(kind=file)` for photos, `MeetingNote`.
- New:
  - a task **start date** (the Gantt needs start and end)
  - task **dependencies**
  - a **part/BOM row** (part, qty, have, supplier, lead days, cost)
  - a **test result row** (board/unit, test, pass/fail, value)
  - a **numeric reading series** for current draw

## 7. Perf budget
- **SVG and CSS only.** Every chart (ring, spark, bars, heat, band, treemap, Gantt, graph) is a hand-written SVG primitive in `kit/ui.tsx`, about 3 kB gzipped in total. No new chart dependency.
- **Code-split per desk**: each desk's widgets load through `React.lazy(() => import('widgets/<persona>'))`. Today loads only the active desk's chunk, at 12 kB gzipped or less per desk. Shared primitives go in the common chunk.
- **Today first-load JS** must not grow over the round-2 158 kB. The target is +8 kB or less.
- **No layout animation.** Frames p95 at 16.7ms or less on the apply moment.
- **CLS**: 0.01 or less, because the skeleton equals the final footprint.
- **Fonts**: the existing three families only. The Fraunces numerals use the already-loaded variable axis.
- **Grain**: a single inline SVG data-URI, not an image request.
- **Data**: one `/api/desk/:id/today` aggregate per desk, with no per-tile waterfalls. Tiles render skeletons from layout data before the aggregate returns.
- **Plots slots**: each placeholder is a static tile at ≤ 1 kB gzipped, with no chart library, behind the `plots` flag (see §8).

## 8. Plots slots (reserved)
**Plots** is a separate feature that is still in progress, similar to Block Diagrams on main. Users drop a CSV, Excel or TXT file and plot any column against any other as bar, line, pie and many more types (2D only, no 3D). **Do not build Plots in this round.** This section only reserves clearly labelled places in the desks where plots will slot in later, and fixes the contract those places must honour.

Mockups: the Plot slot tile in S/M/L at the top of **A1**, a 5th row in **A2** (skeleton, placeholder, and an *illustrative* "later" tile), the slots on every **B-today-*** desk (plus Branch 390), and two new surfaces, **X-plots-widget-gallery** (add-a-tile gallery, "Plots" category) and **X-plots-tile-settings** (greyed "Chart type" row). Rendered PNGs are not kept in the repo; `mockups/build-all.sh` renders them again.

### 8.1 The placeholder tile (what ships)
- **Anatomy** follows the empty-ghost language (§4). It shows a dimmed ghost chart with faint **bar, line and pie** silhouettes (about 40% opacity, 0.4 saturation, masked toward the bottom) inside a dashed inner frame, which reads as "reserved", not "broken". It also carries:
  - the chip **"Plots · coming soon"** (shortened to "Plots · soon" on a 3-col S tile) in the header's right slot
  - one line: **"Drop a CSV, Excel or TXT file and plot anything against anything"**
  - one **disabled "Add data"** action (dashed, faint, `aria-disabled="true"`, not focusable as a button)
  - on L only, a quiet caption: "Bar, line, pie and more · 2D only"
- **Title** names the future chart (e.g. "Load trend"). The meta reads "plot slot · …" from 4 columns up, and is dropped below that. The tile takes the desk accent.
- **States:** the skeleton is a chart block plus a pie circle. The placeholder is the only other state that ships. The "populated" tile in A2 is illustrative, the same footprint once Plots exists. It is not a spec to build now.
- **Sizes:** the normal grid sizes (§2). **S** is 2 rows (156px) at 3–4 cols. **M** is 3 rows (240px) at 3–4 cols. **L** is 4 rows (324px) at 5–6 cols.
- **Build:** a **lightweight static tile**. That means no chart library, no data fetch and no JS state, just one static SVG and a few classes. The budget is **≤ 1 kB gzipped** (markup + component). The mockup's React markup, with inline styles, measures about 1.4 kB gz, plus about 0.8 kB gz of CSS. Production reaches ≤ 1 kB by using classes and one pre-drawn SVG. The CSS goes in the shared stylesheet.
- **Flag:** it is hidden behind a **`plots` feature flag** (default off) until Plots exists. With the flag off:
  - the slot is not rendered
  - the neighbours use their approved pre-Plots spans (table below), so the grid stays full
  - the Billable toggle, the Mock scores chip and the gallery's Plots category are hidden
  - the "Chart type" settings row is hidden

  The widget counts in the gallery and detail pages exclude slots.

### 8.2 Affordances on existing charts (not new tiles)
- **Chambers · Billable:** a **"Ring · Plot"** segmented toggle in the header. Ring stays selected and shows the unchanged ring plus daily bars. Plot is faint and carries a **SOON** tag, and is not selectable. "this week" moves into the sub-line ("of 40 h · this week") to make room.
- **Exam season · Mock scores:** a dashed **"Plot-ready · Line ⌄ · SOON"** chip in the header. It shrinks to "Line ⌄ · SOON" at 4–5 cols and on 390. It says the line can later become any Plots chart type. "10 mocks" joins the meta.
- **Add-a-tile gallery:** a **"Plots"** category marked *soon*, with 3 display-only cards, each marked coming soon with a disabled Add:
  - **Plot**: any vs any, sizes S/M/L
  - **Trend over time**: M/L
  - **Breakdown**: pie or ranked bar, S/M

  It also has a "plot-ready on this desk" strip.
- **Tile settings:** a greyed, dashed **"Chart type"** row with a lock icon, a disabled "Line ⌄" select and the chip, plus "Reserved for Plots: bar, line, area, pie and more, 2D only."

### 8.3 Plot widget contract (for later)
```ts
type PlotWidget = {
  kind: "plot";
  dataset: { ref: string /* uploaded CSV | XLSX sheet | TXT (delimiter sniffed) */; sheet?: string; version: number };
  x: { column: string; type: "number" | "date" | "category" };
  y: { column: string; type: "number" }[];            // 1..4 series
  series?: { column: string; max: 8 };                  // split by category
  chart: "bar" | "line" | "area" | "pie" | "donut" | "scatter" | "stacked-bar" | "histogram" /* …2D only */;
  aggregation: "none" | "sum" | "avg" | "count" | "min" | "max" | "median";
  bucket?: "day" | "week" | "month";                    // when x is a date
  size: "S" | "M" | "L";                                // same grid sizes as §2; no XL
  guardrails: {
    maxRows: 50_000;           // import cap; larger files are sampled with a visible note
    maxPoints: 500;            // after aggregation, per series
    typeChecks: true;          // x/y types verified on import; mismatched rows are counted and shown, not dropped silently
    pieMaxSlices: 8;           // the rest fold into "Other"
    no3D: true;
  };
};
```
- A slot is a `PlotWidget` with `dataset` unset. Filling the slot keeps its footprint and position, and the tile moves from placeholder to populated in place.
- **Shared chart primitives.** The existing chart widgets must be built on the shared primitives in `kit/ui.tsx` (Ring, Spark, Bars, Heat, Stacked, Seg) **behind one small interface Plots can later drive**, roughly `ChartSpec { type, series[], x, y, target?, band? } → <Chart/>`. This covers mock scores, Billable (ring + bars), all the sparklines (Branch activity, Pump current, Unbilled, Mock trend), Reading streak, Daily hours and the others. Then Billable's toggle and Mock scores' plot type chip become a change of `type`, not a rewrite, and Plots adds renderers without a second chart stack.

### 8.4 Slot table (1440, 12-col bento; col/row are 1-based grid lines from the top-left of the bento)
| Desk | Tile | Size | Position (cols × rows) | Flag off: neighbours revert to |
|---|---|---|---|---|
| Default | **Focus time** (Plot slot) | M · 3×3 | cols 10–12 × rows 8–10, end of the 3rd band, after Deliverables, People, Reminders | Deliverables, People, Reminders 3 → 4 cols |
| Semester | **Study hours** (Plot slot) | M · 3×3 | cols 10–12 × rows 9–11, after Study plan, Mini-project, Reading | the three 3 → 4 cols |
| Exam season | **Mock scores** (plot-ready chip) | M · 6×3, in-tile | cols 7–12 × rows 5–7, header right | chip hidden, "10 mocks" back in the right slot |
| Literature desk | **Reading trend** (Plot slot) | M · 3×3 | cols 10–12 × rows 5–7, beside Reading streak | Chapter 2 draft, Citation graph, Reading streak 3 → 4 cols |
| Chambers | **Billable** (Ring · Plot toggle) | M · 3×3, in-tile | cols 7–9 × rows 5–7, header right | toggle hidden, "this week" back in the meta |
| This week's classes | **Marks by class** (Plot slot) | L · 6×4 | cols 7–12 × rows 8–11, right of the 2×2 cluster of Attendance, PTM, Duty, Paper to set | slot removed; the four S tiles return to one 4×3-col band |
| Staff week | **Load trend** (Plot slot) | M · 4×3 | cols 9–12 × rows 5–7, after 1:1 cadence and Q4 objectives | 1:1 cadence and Objectives 4 → 6 cols |
| Branch desk | **Commit trend** (Plot slot) | S · 3×2 | cols 10–12 × rows 8–9, after In progress, Blocked, Done this week | the three 3 → 4 cols |
| Bench | **Current draw · series** (Plot slot) | L · 6×4 | cols 7–12 × rows 9–12, right of Spend, Lead time, Pump current, Next milestone (2×2) | slot removed; the four S tiles return to one band |
| Branch desk · 390 | **Commit trend** (Plot slot) | S · 4×2 | last tile, after Deploys | removed |
| Chambers · 390 / Exam · 390 | Billable toggle / Mock scores chip | in-tile | as at 1440 | hidden |

Every desk PNG was re-checked for holes: no orphan gaps at 1440 on any desk.
