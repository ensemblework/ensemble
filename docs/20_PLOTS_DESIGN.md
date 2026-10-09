# 20 · Plots

Plots is Ensemble's one-stop 2D chart tab. It is for someone who already knows what a figure should do: an analyst, a data scientist, or an ML researcher. The defaults follow publication practice. Decoration that makes a value harder to read is left out.

Hosted arbitrary Python plot execution requires a verified operator (`lib/hosted-access.ts`, `runtime/plot-run.ts`, Python `plots/sandbox.py`). Public users are not allowed to run Python on the shared server. Dataset imports are account-scoped and subject to hosted storage limits. Desktop/local execution retains its existing behavior.

Caching below follows [CACHING.md](CACHING.md) and [UI_PERF_DESIGN.md](UI_PERF_DESIGN.md): measure first, keep any cache small, and invalidate it when the bytes change.

The desk already reserves plot *slots* behind the `desk.plots` preference (`docs/design/desk/SPEC.md` §8). Those slots stay lightweight static tiles. The product is a module, `plots`, default **off**, with the same Enable landing as Code and Block diagrams.

## 1. Charting library

Compared for a commercial or freemium product. All of these are open source with a licence that allows that use.

| Library | Licence | Interactivity | Dual Y | Large data | Export | Bundle | Theming | Native later |
|---|---|---|---|---|---|---|---|---|
| **Apache ECharts 5** | Apache-2.0 | Zoom, pan, brush, tooltip, legend toggle, click, axis pointer | First-class `yAxis[]` | Canvas, progressive render, built-in LTTB / average / min / max sampling | Canvas PNG via `getDataURL`; a second instance with the SVG renderer for vector SVG | ~1 MB minified, ~300 KB gzip, loaded only on `/plots` | Theme object; CSS variables mapped in | JSON option is portable. A later Mac/Windows/Linux shell can host the same page in a webview. Publication files come from matplotlib, which is already native |
| Plotly.js | MIT | Excellent, including box and violin | Yes | `scattergl` is WebGL; most other traces are SVG and stall | PNG/SVG in the browser; PDF needs Kaleido, a native extra | ~3 MB minified. Painful even when lazy | Yes | Plotly.py is native, but the JS bundle is the problem |
| Vega-Lite | BSD-3 | Needs Vega embed; brush and zoom are extra specs | Awkward (`resolve` + layers) | SVG/canvas, not happy at 100k points | SVG | Medium-large (Vega + Vega-Lite) | Yes | A grammar, not a widget. Still a browser runtime |
| Observable Plot | ISC | Facets and pointers; thinner zoom and brush | Not a first-class pair of scales | SVG. 100k points is the wrong tool | SVG is the render | Smaller than Plotly | Marks, not a theme engine | Browser only |
| uPlot | MIT | Zoom and cursor, built for series | A second scale is manual | Canvas, the fastest small library here (~50 KB) | Canvas bitmap | Tiny | CSS | No pie, heatmap, violin, or box without writing them |
| Recharts / visx | MIT | Recharts is a React SVG wrapper. visx is marks, so every interaction is ours | Recharts yes. visx is DIY | SVG. Both fall over well before 100k | SVG | Recharts is moderate. visx depends on how much we write | React props | Browser only |

**Choice: Apache ECharts**, lazy-loaded from the Plots studio only. Other routes do not import it.

Why this one:

- Dual axes, legend toggling, toolbox-style zoom, inside data zoom, brush, and a crosshair are configuration, not a second project.
- `sampling: "lttb"` plus `progressive` keeps a line of 100k points on canvas. Scatter uses `large` mode.
- `markLine` and `markArea` are the reference lines and shaded bands. They are annotations, not series.
- Bar, line, area, step, pie, scatter, boxplot, heatmap, and custom series cover the chart list. Waterfall is a stacked bar with a transparent base. Violin is a kernel-density ribbon we compute and draw as a custom series. Combo charts are bar and line series on one grid.
- SVG export is a second, off-screen chart with `renderer: "svg"`. PNG is the canvas chart at a chosen pixel ratio.
- Apache-2.0 is acceptable for a commercial or freemium product. We do not ship ECharts GL. That package is the 3D path and a second large payload.

Plotly's scientific traces are better out of the box (violin, error bars). The bundle and the Kaleido PDF dependency are not. uPlot is the wrong shape for a one-stop tab. Vega-Lite and Observable Plot are grammars for articles, not for this editor.

The chart *spec* Ensemble stores is our own JSON (`PlotConfig` in `@ensemble/shared-types`). ECharts is a renderer. Matplotlib is the other renderer. A future native shell does not have to embed ECharts if it can draw the same spec.

### Pseudo-3D

There is no pseudo-3D mode. Extruded bars and tilted pies change how large a value looks (Cleveland and McGill; Tufte). ECharts GL would add WebGL and a second library for an effect that is off by default and worse when on. The data stays 2D because the chart stays 2D. The style panel says so in one line.

## 2. Data ingestion

A dataset is an account object: id, name, column list, row count, content hash. The bytes live under the server's data directory, keyed by user id and dataset id. The API never returns that path. `load("sales")` in the sandbox resolves the name the user picked; the runtime copies the table into a temp directory under a private filename.

### Where parsing happens

| Format | Where | How |
|---|---|---|
| CSV, TSV | Browser, and again in hub-api if the text is posted raw | Shared parser in `@ensemble/shared-types` (`plots-parse`). RFC-style quotes. Delimiter can be forced or sniffed |
| Formatted TXT | Same | Sniff among space, tab, pipe, semicolon. Header row when the first row is not numeric. Column types inferred, then overridable |
| JSON, JSON Lines | Same | Array of objects, `{ rows \| data \| records: [...] }`, or one object per line |
| Paste | Browser | Same parsers. The user can override the delimiter |
| xlsx, xlsm | agent-runtime | openpyxl. Macros in xlsm are not executed; only cell values are read. Sheet list returned; the user picks a sheet |
| xls | agent-runtime | xlrd |
| ODS | agent-runtime | pandas with odfpy |
| Apple Numbers | agent-runtime | numbers-parser. Sheet (table) selection |
| Parquet, Feather | agent-runtime | pyarrow. No Python code from the file is executed |
| Pickle | Rejected | See below |
| Google Sheets, Google Drive, OneDrive, SharePoint | hub-api fetches, then the parser for the bytes | Public or export links only |

The browser parses text so a CSV preview appears before an upload finishes. The server parses the same text on the way in, so a client cannot skip type checks by posting a lie as "already parsed" without us also accepting an explicit table (the agent tools post a table). Binary formats need the runtime. If the runtime is down, the UI says so and still accepts CSV, TSV, TXT, JSON, JSONL, and paste.

`POST /api/plots/:id/export.csv` uses `tableToCsv` in `packages/shared-types/src/plots-parse.ts`, shared with sample tables. Headers and string cells containing commas, quotes, or CR/LF are CSV-escaped, not JSON-escaped; the parser preserves quoted multiline records. Export/re-import regressions check the actual column names and values.

Explicit `{ columns, rows }` table imports are strict: 1-64 uniquely named columns, rectangular rows, finite JSON numbers for numeric columns, and ISO/year-first dates or valid numeric timestamps for date columns; `null` remains a missing value. Malformed explicit tables return 400 before creating records/files (`src/plots/service.ts`). Text-file parsing and user-selected column overrides retain their existing behavior.

### Pickle

Ensemble does not unpickle. `pickle.loads` on untrusted bytes can run arbitrary code via `__reduce__`. A subprocess does not fix that: the child is still our process user. Restricted unpicklers have a long history of bypasses. Pandas `read_pickle` is the same loader.

The user is told to export Parquet or Feather. Both are columnar, typed, and read without executing code. A `.pkl` / `.pickle` upload returns that error and writes nothing.

### Limits

- Upload body: 32 MB.
- Stored rows: 200,000. Past that, the import keeps the first 200,000 and shows the count it dropped.
- Preview table: first 80 rows. The chart still aggregates the stored rows.
- Draw: lines and areas use LTTB down to about 4,000 points per series for the on-screen series. Bars, pies, and heatmaps aggregate first, then cap categories (40, pie slices 8 plus Other). Scatter at 100k uses ECharts large mode.
- Encoding: UTF-8 (BOM stripped). If UTF-8 is invalid, Windows-1252. Python uses the same order.
- Dates: ISO-8601 and `YYYY/MM/DD` become dates. A day/month pair that is ambiguous (`01/02/2024`) stays text until the user sets the column to date, so we do not silently swap a US and an EU reading.
- Decimals: if a column is mostly `1.234,56` or `1234,56`, the comma is the decimal mark. Otherwise the dot is. The user can override the column type.

### URLs and SSRF

Only `https`. The host must match an allowlist after DNS resolution, and every redirect is checked again (at most 4).

| Source | What works |
|---|---|
| Google Sheets | `/spreadsheets/d/{id}` is rewritten to the public CSV/XLSX export URL. The sheet must be shared so "anyone with the link" can view. A gid is kept |
| Google Drive file | `/file/d/{id}` is rewritten to `uc?export=download`. Public files only |
| OneDrive / Excel Online | `1drv.ms`, `onedrive.live.com`, and the `*.files.1drv.com` download hosts those redirects use. A link that bounces to a Microsoft login page is refused with "use a public download link" |
| SharePoint | Hosts ending in `.sharepoint.com`. Same rule: an HTML sign-in page is not a spreadsheet |

No connector token is reused. The Google sign-in on Connections is Gmail and Calendar read-only. It is the wrong scope for Sheets, and a token must not be sent to the browser or written into a log. The URL host is logged. The query string is not, because shared links sometimes carry secrets.

Rejected before any connection:

- Non-https, missing host, username/password in the URL.
- IP literals and DNS answers in loopback, private, link-local, CGNAT (`100.64/10`), multicast, or the cloud metadata address `169.254.169.254`, including IPv4-mapped IPv6.
- Hosts outside the allowlist, including a redirect onto one.
- Bodies over 32 MB, or slower than 15 seconds.

## 3. Figure defaults

Checked against the 2025 style files, not a blog summary.

| Preset | Page | Figure width | Height we use | Type |
|---|---|---|---|---|
| **ICML** | Two columns. `textwidth` 6.75 in, `columnsep` 0.25 in, body 10 pt Times (`icml2025.sty`) | Single column **3.25 in**. Double column **6.75 in** | 2.4 in / 3.2 in | Serif |
| **NeurIPS** | Single column. Text rectangle **5.5 in** by 9 in. 10 pt Times (`neurips_2025.sty`) | Full **5.5 in**. Half **2.65 in** (two figures side by side) | 3.2 in / 2.3 in | Serif |
| **ICLR** | Same rectangle as NeurIPS: **5.5 in** by 9 in, 10 pt Times (`iclr2025_conference.sty`) | Full **5.5 in**. Half **2.65 in** | 3.2 in / 2.3 in | Serif |
| **Ensemble** | On-screen, not a paper | The panel width | ~3.4 in equivalent | Sans, the app accent allowed |

The often-quoted "3.25 in / 6.75 in" pair is ICML, not NeurIPS. NeurIPS and ICLR 2025 are a 5.5 in measure. A 6.75 in figure does not fit them. The preset picker is how the user chooses.

On-screen text uses the app face. Publication export uses a serif close to Times (Liberation Serif, Nimbus Roman, or STIX, then DejaVu Serif). Sizes, in points: axis labels 9, ticks 8, legend 8, title 10. Nothing below 7. Captions stay in the paper, so the matplotlib figure has no "Figure 1" baked in. ICML asks for no title inside the figure; the title field is optional and off for the ICML preset unless the user typed one.

Other defaults, chosen because they survive a print reduction:

- Lines at least 1.25 pt (ICML asks for 0.5 pt minimum; we stay thicker so a reduced figure still prints).
- Markers on when a series has fewer than 24 points. Past that, the line is enough.
- Light grid, low contrast, behind the data.
- Despined axes: top and right spines off.
- Error bars and confidence bands drawn, bands at low opacity so the line stays primary.
- Legend below the axes when there is more than one series, frame off. The user can move it.
- Categorical palette: **Okabe–Ito** (the black swatch becomes a light neutral in dark theme so it stays visible). Also offered: Tableau 10, ColorBrewer Set2.
- Sequential: viridis. Diverging, when a heatmap crosses zero: ColorBrewer RdBu.
- The app accent is a palette *option*, not the default. A paper figure should not depend on a user's purple.

PDF and EPS set `pdf.fonttype` and `ps.fonttype` to **42** (TrueType outlines embedded). Type 3 fonts are how a figure gets rejected or looks fuzzy in a proceedings build.

## 4. What the tab does

Disabled until the person enables Plots. `/plots` then shows the blurred landing and Enable. Enabling adds the sidebar item, the command-palette entries, a Saved plots tile on Today (starter tour, skippable), and the assistant tools. Turning it off hides those and leaves the rows.

1. **Drop, pick, paste, or paste a URL.** Preview table with a type menu per column (number, date, category, text).
2. **Charts.** Line, multi-line, area, stacked area. Bar, grouped, stacked, 100% stacked, horizontal and vertical. Pie, donut. Scatter, bubble. Histogram, box, violin. Heatmap. Error bars and bands. Step. Waterfall. Combo bar + line.
3. **Encodings.** X, one or many Y, colour-by, aggregation (sum, mean, count, median), sort, one filter, log scales.
4. **Dual Y.** Each series is left or right, with its own scale, title, and log flag.
5. **Interaction.** Tooltip, wheel zoom, box zoom via data zoom, pan, reset, brush a range (offered as a filter), legend toggles a series, click a bar or slice to recolour it, crosshair.
6. **Style.** Per-series colour, dash pattern (solid, dashed, dotted, dash-dot), width, marker, opacity. Title, subtitle, axis titles, tick format, legend position, grid, font size. Palette presets.
7. **Annotations.** Horizontal line, vertical line, `y = mx + c`, shaded band. Label, colour, dash. Not data.
8. **Export.** PNG at 1×, 2×, 4× and a custom DPI. SVG. CSV of the plotted (aggregated) rows. Copy PNG. Matplotlib source. Server render of that figure to PDF, SVG, PNG, and EPS in the chosen preset. *Settings › Data › Download this space* with Plots ticked adds each plot space's settings as JSON and its data as CSV; it does not render figures.
9. **Code view.** CodeMirror with the Code tab's theme, Python mode, lazy-loaded. Boilerplate calls `load` / `save`. Run goes to the sandbox. `plt.show()` and `save()` both capture the figure. The script is stored on the plot.
10. **Saved plots.** Dataset id, config, style, annotations, optional code. Autosave. Duplicate. `@` mention renders a card and opens the plot. Ask search returns plots when the module is on. Assistant tools create and edit a plot the same way they create a task (a write waits for Apply). The Context Bridge can read a plot and cannot write one.

## 5. Matplotlib and the sandbox

`ensemble_plots` is injected into the sandbox. It is not a package on PyPI.

```python
from ensemble_plots import load, save
import matplotlib.pyplot as plt

df = load("sales")  # the dataset chosen in the plot, by the name the user sees
fig, ax = plt.subplots()
ax.plot(df["month"], df["revenue"])
save(fig)           # or plt.show()
```

`load` reads a JSON table copied into the temp directory for that run. It does not accept a path. An unknown name raises a normal Python error listing the names that exist.

The sandbox is a short-lived child of the agent-runtime:

- Working directory is a fresh temp dir, deleted after the run.
- Environment is scrubbed (no proxy or cloud credentials). `MPLCONFIGDIR` is a per-user cache so warm workers can reuse fonts.
- CPU and file-size rlimits apply on macOS and Linux. `ENSEMBLE_PLOT_MEMORY_MIB` sets a 64-2048 MiB per-child budget (default 2048). Linux applies an address-space rlimit. macOS does not enforce that rlimit: the parent samples resident memory with native `libproc` and kills an oversized child's process group. This is a sampled budget, **not an instantaneous hard ceiling**. Low budgets must accommodate scientific imports. Windows still has no equivalent memory rlimit here.
- Wall-clock budgets are 45 seconds cold, 25 seconds warm in the Python Mac sandbox and 20 seconds warm on the hosted path; the in-process sidecar uses its own `plots-python.ts` budgets. Output is capped. At the limit the child's whole process group is killed.
- Exports run `ENSEMBLE_PLOT_CONCURRENCY` at a time (default 2, 1 on the 4 GB VM). An export waiting behind others gives up after at most 110 seconds (`PLOT_QUEUE_WAIT_CAP_S`) with a busy reply, which stays under Vercel's 120 second proxy cut. The wait starts counting each export ahead at its own limit.
- Import hook rejects `socket`, `subprocess`, `ctypes`, `multiprocessing`, `pickle`, `http`, `urllib`, and similar. Allowed scientific stack: numpy, pandas, matplotlib, seaborn, scipy, and what those import from the runtime environment.
- After the stack is imported, `socket` connect and `os.system` / `subprocess` are replaced with functions that raise, and a Python audit hook refuses `open` outside the temp dir, the interpreter prefix, and font directories.
- Tracebacks are returned as text and refer to `user_script.py` line numbers.
- No network calls are made by the runtime on the user's behalf during a plot run.

On Mac, the Python runtime launches the Node/tsx loader directly into the shared Seatbelt choke point, not through a second CLI wrapper. The profile grants only metadata for ancestors needed by interpreter `realpath`, plus read-only interpreter/worker files; it does not open ancestor contents, sibling files, credentials, or extra writes. Startup/queue failures remain 503 with retry information, distinct from invalid figure code.

Stale-directory cleanup keeps directories still used as process working folders. When process inspection is unavailable, it emits a warning and leaves old folders alone rather than risk deleting active work.

This is a process sandbox, not a VM. It is the same idea as the Code tab's guarded terminal: allow the job, refuse the rest. It does not depend on Docker, so it runs on a developer Mac, a Windows PC, and Linux.

## 6. Caching

Parsed tables are not stored in Redis. They are a file plus a Postgres row of metadata.

One in-process LRU in hub-api holds up to 8 parsed tables, at most 64 MB together, for 10 minutes, keyed by dataset id and content hash. It exists because export, matplotlib, and the mention card all reread the same table during one editing session, and a 100k-row JSON parse showed up as the slow part of that path. Replacing or deleting a dataset drops the entry. Chart config is a small JSON column and is not cached. The browser keeps the open table in memory for the studio only.

## 7. Performance

ECharts and CodeMirror are dynamic imports from the studio and the code pane. The Plots list page does not import them. Loaders use `useDelayedFlag`, so a fast parse does not flash a spinner. Desk tiles do not import ECharts; the Saved plots tile is a list of links.

## 8. Tiled workspace

The primary surface is a canvas of chart tiles, called a **plot space**, not a page that edits one figure. (A plot space lives inside one Ensemble space; see [28](28_ENSEMBLE_SPACES.md).) A saved single plot still opens in the studio. An account can create and name multiple plot spaces and switch between them in `components/plots/workspace.tsx`. Each is stored as a plot whose config has `kind: "workspace"`. Layout and tile config autosave; switching saves the current space before opening another. Plot spaces organize charts and files within an account; they are not independent Ensemble spaces or a context-isolation boundary.

`POST /api/plots` accepts a workspace config to create a space. `GET /api/plots/workspace?id=<id>` opens a specific owned space, and `PUT /api/plots/workspace` accepts an optional `id` to save it. Omitting the ID preserves the existing most-recent-space behavior. Workspace dataset IDs are ownership-checked on create/update/save, and `GET /api/plots/:id` retains workspace configs rather than flattening them into single-chart defaults.

Older `/plots/<space-id>` links redirect to `/plots?space=<id>` rather than opening a workspace in the single-chart studio. Renaming a space patches only its title, so it cannot overwrite a queued layout save.

### Packing

Compared:

| Tool | Layout | What it teaches |
|---|---|---|
| Notion | A vertical stack of blocks | No free placement. Wrong model for several figures at once |
| Grafana | 24-column grid, vertical compact | Panels keep the column the user dropped them in. Gaps above a panel close. Overlaps push the other panel down |
| Hex, Observable | Notebook cells | One reading order. A canvas is not a notebook |
| tldraw | Free coordinates on an infinite surface | Precise placement, and also large empty holes |

Ensemble uses a **12-column grid with vertical compaction**, the Grafana rule. Each tile stores `col`, `row`, `w`, `h`. A gutter separates every tile. The chart is clipped to the tile and a `ResizeObserver` calls `chart.resize()`, throttled to one animation frame, including while the tile is dragged or resized. During the gesture the other tiles reflow to the packed cells, so nothing overlaps, and a dashed ghost marks the cell the pointer is aiming at. On pointer-up that packing is what gets saved. Overlapping tiles are pushed down, then every tile moves up until it hits another tile or the top. The horizontal cell is left alone, so a tile the user parked on the right stays on the right. Empty rows between tiles do not survive, which is the white space worth removing. Minimum size is 3 columns by 3 rows, so a tile cannot collapse into an unreadable sliver.

Click selects the tile and opens quick edit on the tile (title, series colour, line style). It does not expand. Double-click, the Open button, or Enter expands the tile into the focused editor: the chart, plus encode, style, lines, code, export, and which series sits on the left or right axis. The panel scales open and closed. Hover shows the resize handles, Open, and Delete. The two gestures do different things, so neither has to guess.

With the tile itself focused, arrow keys move it by one cell, Shift+arrow resizes it, Delete removes it and Enter opens it. Inputs and other controls inside a tile retain their normal editing keys. Explicit tile removal offers a toast Undo that restores the configuration into a free grid position (`components/plots/workspace.tsx`). Escape closes the editor; a nested popover consumes Escape first.

Below 768 CSS px, the focused editor stacks its chart preview above a full-width scrolling settings panel, hides the width resize grip, and keeps Back reachable (`components/plots/focus-editor.tsx`). Chart settings tabs use Left/Right, Home and End. Checked locally 9 Oct 2026 at 320 × 800 and 390 × 844 CSS pixels; this is viewport testing, not physical-device certification.

### Adding a tile

Add tile opens a gallery of chart types, including the paper figures below, drawn as small previews. The next step is one searchable list of columns from every dataset on the workspace. The user picks X and Y there. The flow never asks which file. A column's type is always shown. The file name is shown only when that column name is not unique, because that is when the hint changes which column you get.

### Uploads belong to the workspace

The upload dialog is titled Add data. It accepts a drop, a public Sheets, Drive, OneDrive, or SharePoint link, a paste, and the formats in §2. Progress is a percentage, not a spinner. Reading the file is the first slice of the bar (bytes read over file size). Scanning a text file for rows is the next slice. The upload request is the next slice (`loaded / total` on the request body). The bar reaches 100 when the server has returned the column list, which is when parsing finished. A link fetched on the server has no byte events until that response, so the bar stays at the last known percent and then completes. It does not spin.

The next screen lists the file name, the row count, the columns, and the detected types. Each type can be overridden. OK keeps the dataset on the workspace. Cancel deletes it. The dialog and the add-tile gallery sit on a solid panel. Opacity is only on the backdrop.

### Duplicate column names

Tableau relationships, Power BI models, and pandas `merge` all refuse to pretend that two columns are the same just because they share a name. A relationship is an explicit key. Power Query suffixes the collision (`time.1`). Observable keeps tables separate until the notebook joins them. A single switch that "syncs every duplicate" would join a key and a measure with the same gesture, and it would hide a type mismatch.

Ensemble keeps columns **separate by default**, disambiguated by file only when the name collides. The shared-name control is **per name**, and it is **absent when every name is unique**. The choice is made in the upload summary when the new file collides with a name already on the canvas. After that, a small dismissible Shared columns chip in the toolbar opens the same per-name choice. The chip is not shown when the current tables have no collision, including an empty canvas. For a duplicated name:

- **Keep separate.** Two entries in the pool (`time` from `train.csv`, `time` from `eval.csv`). This is the right call for two measures that happen to share a name (`accuracy` in an ablation file and `accuracy` in a scaling file).
- **Join on this column.** Offered only when every copy has the same type. Tiles can then plot a measure from one file against a measure from another on that key (inner join on the values). A number paired with text cannot be a key. The control stays, and Join is disabled with the reason.

The choice is not global. `time` can be the key while `accuracy` stays two columns. A pool entry is stored as an internal reference (a dataset id plus the column, or a join plus the column) separated by a unit separator. A null byte is not used, because Postgres cannot store one inside the workspace JSON.

### Paper figures

These are gallery entries, not a second chart engine. The gallery is grouped into Paper figures and Everyday charts, and each type has its own thumbnail (a band, error bars, log ticks, a Pareto staircase, a matrix, a reliability diagonal, violins). A training curve tells the user it wants a step, a measure, and an optional seed: per-seed rows are averaged and the sample standard deviation is shaded. An ablation wants a mean and an error column and draws error bars. A scaling law uses logarithmic axes. Matplotlib export of one tile is unchanged. Export of the canvas opens a dialog with a large preview, the venue preset and column width (ICML, NeurIPS, ICLR, CVPR), panel order, a shared legend, and PDF, SVG, PNG, or EPS. The script plots each tile's table, including a join, so the file matches the canvas rather than one of the source files. Panel labels `(a)`, `(b)`, … sit at the outside top-left of each axes.

An empty space starts with **Upload a table**, not generated sample data. There is no Try sample data action. Previously saved sample canvases can still be cleared; removing the entry point does not delete existing user data.

| Gallery entry | What a paper uses it for | Chart |
|---|---|---|
| Training curve | Mean over seeds, shaded standard deviation | Line, error drawn as a band |
| Ablation bars | Grouped bars with error bars | Bar, error drawn as bars |
| Scaling law | Log-log of loss against compute or data | Line, both axes logarithmic |
| Pareto front | Two objectives, one point per run | Scatter |
| Confusion matrix | Class against class | Heatmap |
| Reliability | Confidence against accuracy, with the diagonal | Line plus `y = x` |
| Run distribution | A violin or box across seeds | Violin |

Qualitative image grids are not a tile yet. The importers do not carry images, and a fake grid of empty frames would pretend otherwise.

Custom Python stays. `load(name)` resolves every dataset on the workspace, by the name the user sees. `save()` still captures the figure. No file path is shown.

### Plots inside pages

The `@` menu offers one Plots category. `@plots:` browses named spaces, then their tiles; saved single plots live under Saved plots. Uploaded CSV/Excel/other tables appear as data-file mentions, found through either `@plot:<name>` or `@plots:<name>`. Tile identity includes the space ID, so identical tile titles do not select the wrong chart. The entity endpoint is user-scoped and omits this hierarchy when the Plots module is off.

An inline `@ensemble` request can use a dataset mention to create a saved plot and attach it below its answer. `components/plots/plot-card.tsx` renders actual ECharts charts for saved plots and workspace tiles, including axes/series, rather than an empty sparkline. The embed is page-width, follows chart or tile proportions until resized, and provides compact/expand and remove controls. Its bottom bar resizes the height (drag or arrow keys, 160 px minimum); the height is saved on the mention. Removing it (or Backspace) changes only the document; the saved chart and source files remain.
