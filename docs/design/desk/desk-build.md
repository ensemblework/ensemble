# Build brief: implement the approved Desk mockups (feature-2, PR #8)

Prajwal approved the attached high-fidelity mockups ("Looks great, build it as designed"). Build them faithfully in the product, on branch feature-2 (PR #8). Do not merge.

Attached:
- SPEC.md: tokens, grid, tile sizes, widget anatomy, the 3 states, motion, each desk's widgets and data needs, and the perf budget.
- mockups-src.tar.gz: the React/TSX mockup source. Reuse the chart primitives and components directly where you can.
- The PNGs: A (widget kit, 3 states), B (Today for each desk plus Default, and 390 views), C (new user), D (Context), E (gallery), F (detail), G (apply moment), H (before and after).

Scope:
1. Templates: 8 persona desks plus Default, exactly as the mockups show.
   - Merge Exam sprint and Prelims into "Exam season", and cut the 9th template.
   - Give each desk its board rename and labels ("Filing" everywhere in Chambers).
   - Only Branch desk keeps Code.
   - Migrate accounts already on a removed template to Exam season or Default, with no data loss.
2. Widgets: every widget in A1, with the skeleton, empty-ghost and populated states from A2.
   - The empty state is a dimmed preview plus one action, never a blank tile.
   - The skeleton matches the tile's final shape.
3. Grid: a 12-column bento with fixed heights per size. A tile is never taller than its content, and there are no big empty tiles.
4. The "Try with sample data" banner and flow (C). Samples are clearly marked, and clearing takes one click with Undo.
5. The Context overview lens tiles (D): matter/paper cards, people grouped by role with avatars, artifacts with type icons, and lens tiles.
6. The gallery with scaled real desk miniatures, the featured row, persona chips and search (E). The detail page shows a populated preview and a plain-language diff (F). The apply moment rearranges the desk, then shows "You're on X · Undo" with role="status" (G).
7. Data model (SPEC §6): add what the widgets need, additively, via migrations.
   - Timetable slots (recurring class slots), task start dates and dependencies, per-person capacity and leave.
   - Attendance, objective progress, 1:1 cadence target.
   - Matter stage and court, order date with a limitation rule (computed dates) and a court holiday list.
   - Exam date and phases, subject weight, mock max score and cut-off, revision fields.
   - Paper metadata and pipeline stage, citation links, word count.
   - PR check status and deploy events, parts rows, test result rows, reading series, grading expected vs marked.
   Where real data doesn't exist yet, the widget shows its empty-ghost state. Never fake live data outside marked samples.
8. Fix the round 2 Lows along the way:
   - Revert should step back, not forward.
   - The samples line should disappear after clearing.
   - Task drag inside a project lane should persist.
   - Lane counts should match the cards.
   - Task cards shouldn't show a FILE badge.
   - Settings shouldn't fetch the code and terminal endpoints when Code is off.
   - The detail preview should be populated.
   - The toast needs role=status.
   - Starter rows from the signup template shouldn't leak into another desk.
   - Chambers shouldn't list "Filing" twice.
   - Remove the placeholder blurbs.
9. Keep all module gating and security exactly as in round 2 (hub-api 86+ tests stay green).
10. Plots placeholders (SPEC §8 "Plots slots (reserved)"). Do not build Plots.
    - Ship the reserved Plot slot tiles, the Billable "Ring · Plot" toggle, the Mock scores plot type chip, the gallery "Plots" category and the greyed "Chart type" settings row, exactly as in A1, A2, B and X-plots-*.png.
    - Each slot is a static tile of ≤ 1 kB gzipped, with no chart library, behind the `plots` flag (default off). With the flag off, the neighbours keep their approved spans.
    - Build the existing charts on the shared chart primitives behind the interface in §8.3, so Plots can drive them later.

Budgets:
- SVG and CSS only, no chart library.
- Each desk's widgets are code-split at 12 kB gzipped or less.
- /today first-load JS grows by 8 kB or less over 158 kB.
- CLS stays at 0.01 or less.
- Motion uses transform and opacity only, and respects reduced motion.
- Dark is the default. Light must also look right.

Done means:
- Playwright screenshots of every mockup view, taken from the real app with sample data at 1440 (and 390 for Chambers, Exam and Branch), placed side by side with the mockups.
- Tests green.
- Sizes reported.
- An honest list of any differences from the mockups.

## Added after the call (30 Sep, evening)
11. **Commits:** make tiny, focused commits and push them to feature-2 as you go, one logical change per commit (for example "Add the LimitationBand chart primitive"). Never one big commit at the end. Prajwal follows progress commit by commit.
12. **Role is set at signup.** A user's template or role is chosen at signup and regular users can't switch it.
    - Keep /marketplace for testers only. Also add a tester-only persona switcher, available only when `ENSEMBLE_DEV_TOOLS=1` or the account has a dev or tester flag. It could be a palette command or a Settings → Developer row, so developers can jump between desks without new accounts.
    - Regular users never see it, and the server refuses a switch without the flag.
    - Default stays available to testers.
13. **Build on main (d2e73f6+).**
    - Diagrams is its own module, `diagrams`, on for every desk. Only its repo-reading tools need Code.
    - Add a Diagrams desk widget: a server-rendered SVG thumbnail of linked diagrams, using the block-diagrams server renderer so no ELK or React Flow loads on Today. It's gated by the diagrams module.
    - Use main's tokens: `--accent`, not the mockup's `--a`. Add radius, spacing and elevation tokens to globals.css and Tailwind.
    - The sidebar logo is main's constellation mark, not the bars from the mockups.
    - Fraunces is loaded at weight 500 only on main, so load any other weights the mockups need deliberately and within budget.
