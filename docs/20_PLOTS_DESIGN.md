# 20 · Plots

Plots is Ensemble's 2D chart tab for people who already know what a figure should show: analysts, data scientists and ML researchers. Defaults follow publication practice; decoration that makes a value harder to read is left out.

Plots is an optional module. It is off until the person enables it, and availability follows the profile/template and saved module settings. Desk plot slots use the `desk.plots` preference (`components/desk/view.tsx`).

Where plot Python runs:

- **Desktop and local servers:** the agent runtime's sandbox (§5).
- **Hosted (Ensemble on the web):** server-side Python (rendering, reading binary spreadsheets) runs only for a verified operator (`ENSEMBLE_OPERATOR_EMAILS`; `requireHostAccess` in `lib/hosted-access.ts`, otherwise 403 `HOST_ACCESS_DENIED`). Everyone else runs plot Python in their own browser (§5a). Datasets belong to the account and count against hosted storage limits (§2).

## 1. Charting library

**Apache ECharts** (`echarts` in `apps/hub-web/package.json`), lazy-loaded by the Plots studio and workspace only. Other routes do not import it.

- Dual axes, legend toggling, data zoom, brush and crosshair are configuration. `sampling: "lttb"` plus `progressive` keeps a 100k-point line on canvas; scatter uses `large` mode.
- `markLine` and `markArea` draw reference lines and bands (annotations, not series).
- Waterfall is a stacked bar with a transparent base; violin is a kernel-density ribbon in a custom series; combo charts are bar and line series on one grid.
- SVG export draws an off-screen chart with `renderer: "svg"`; PNG is the canvas at a chosen pixel ratio.
- ECharts GL is not shipped. There is no 3D or pseudo-3D mode: extruded bars and tilted pies distort how large a value looks.

The stored spec is Ensemble's own JSON (`PlotConfig` in `packages/shared-types/src/plots.ts`); ECharts and matplotlib both render it. The desktop Hub uses the same UI.

## 2. Data ingestion

A dataset is an account object (`plotDataset`: name, columns, row count, byte size, content hash, sheets). `plots/store.ts` keeps its parsed table and, for a workbook with several sheets read on the server, the original file so another sheet can be picked later:

| Server setting | Where tables live |
|---|---|
| Blob store on (`ENSEMBLE_FILE_STORAGE=azure-blob`, `lib/blob-store.ts`) | Keys `plots/<userId>/<datasetId>.json.gz` and `.bin` |
| Otherwise | `.ensemble/plots/<userId>/` on disk |

- A CSV, TSV, TXT, JSON or paste keeps only its table, never the text it came from. A file read in the browser (Ensemble on the web) never reaches the server; only its table does.
- The API never returns a path or key.
- With the blob store on, the scheduler's hourly sweep (`jobs/blob-sweep.ts`) moves tables still on disk into it (`moveLocalDatasetsToBlob`; they are read from disk until then) and removes tables of deleted datasets. Deleting a dataset or an account removes its tables at once, best effort; the sweep catches what a failed delete leaves.
- Hosted, a write to the store may take up to 2 minutes inside the account's quota lock (`STORE_TIMEOUT_MS` in `plots/service.ts`).
- In the sandbox, `load("sales")` resolves the name the user picked; the runtime copies the table into a temp directory under a private filename.

### Where parsing happens

| Format | Where | How |
|---|---|---|
| CSV, TSV | Browser, and again in hub-api if the text is posted raw | Shared parser in `packages/shared-types/src/plots-parse.ts`. RFC-style quotes. Delimiter forced or sniffed |
| Formatted TXT | Same | Sniffs space, tab, pipe, semicolon. Header row when the first row is not numeric. Column types inferred, then overridable |
| JSON, JSON Lines | Same | Array of objects, `{ rows \| data \| records: [...] }`, or one object per line |
| Paste | Browser | Same parsers. The user can override the delimiter |
| xlsx, xlsm | agent-runtime | openpyxl. Macros are not run; only cell values are read. The user picks a sheet |
| xls | agent-runtime | xlrd |
| ODS | agent-runtime | pandas with odfpy |
| Apple Numbers | agent-runtime | numbers-parser, with table selection |
| Parquet, Feather, Arrow | agent-runtime | pyarrow. No code from the file runs |
| Pickle | Refused | See below |
| Google Sheets, Google Drive, OneDrive, SharePoint links | hub-api fetches, then the parser for the bytes | Public or export links only |

The browser parses text so a preview appears before the upload finishes. Binary formats need the agent runtime; when it is down, the UI says so and still accepts CSV, TSV, TXT, JSON, JSONL and paste.

On Ensemble on the web, where the server reads binary formats only for its operator, the upload dialog reads xlsx, xlsm, xls, ODS, Parquet, Feather and Arrow in the browser with the runtime's own `parse_table.py` under Pyodide (§5a), asks for a sheet when a workbook has several, and posts the result as an explicit table. Apple Numbers needs a native library Pyodide lacks: export it to Excel or CSV. The browser cannot fetch a spreadsheet link (cross-origin), so it asks the person to download the file and add it.

Explicit `{ columns, rows }` tables (posted by the browser and by the assistant's tools) are strict: 1–64 uniquely named columns, rectangular rows, finite JSON numbers in numeric columns, ISO/year-first dates or numeric timestamps in date columns; `null` is a missing value. A malformed table returns 400 before anything is written (`validateExplicitTable` in `plots/service.ts`).

### Pickle

Ensemble does not unpickle: `pickle.loads` on untrusted bytes can run arbitrary code via `__reduce__`, and neither a subprocess nor a restricted unpickler makes that safe (pandas `read_pickle` is the same loader). A `.pkl` / `.pickle` upload returns 400 (`PICKLE_REJECTION`: export Parquet or Feather instead) and writes nothing.

### Limits

- One file, paste or link: **20 MB** (`MAX_UPLOAD_BYTES`, `UPLOAD_TOO_LARGE` in `packages/shared-types/src/plots.ts`). The upload dialog refuses a larger file before reading it, so it never fills the browser's memory; the server refuses it again once decoded (413 "Files for plots can be up to 20 MB."). The request body may be up to 34 MB (base64, JSON escaping, or a table the browser read).
- Hosted: stored tables count against 100 MB per account (`ENSEMBLE_MAX_DATASET_BYTES`, `checkDatasetBytes` in `lib/hosted-limits.ts`).
- Stored rows: 200,000 (`MAX_STORED_ROWS`). An import keeps the first 200,000 and says so.
- Preview table: first 80 rows (`PREVIEW_ROWS`). The chart still aggregates the stored rows.
- Drawing: lines use LTTB down to about 4,000 points per series; a series over 4,000 points renders progressively, and scatter switches to large mode. Bars, pies and heatmaps aggregate first. At most 12 series are drawn; a pie or donut keeps 4 series and folds slices past the seventh into Other.
- Encoding: UTF-8 (BOM stripped), else Windows-1252. Python uses the same order.
- Dates: ISO-8601 and `YYYY/MM/DD` become dates. An ambiguous day/month (`01/02/2024`) stays text until the user sets the column to date, so a US and an EU reading are never silently swapped.
- Decimals: if a column is mostly `1.234,56` or `1234,56`, the comma is the decimal mark; otherwise the dot. The user can override the column type.

### URLs and SSRF

`plots/ssrf.ts`. Only `https`. The host must be on the allowlist, every DNS answer must be public, and every redirect is checked again (at most 4).

| Source | What works |
|---|---|
| Google Sheets | `/spreadsheets/d/{id}` becomes the public XLSX export URL; a `gid` is kept. The sheet must be shared so anyone with the link can view |
| Google Drive file | `/file/d/{id}` becomes `uc?export=download`. Public files only. `drive.usercontent.google.com` is allowed for the download |
| OneDrive / Excel Online | `1drv.ms`, `onedrive.live.com` (with `download=1`), and the `*.files.1drv.com` hosts they redirect to |
| SharePoint | Hosts ending in `.sharepoint.com` |

Refused before or while connecting:

- Non-https, no host, or a username/password in the URL.
- IP literals and DNS answers in loopback, private, link-local (including `169.254.169.254`), CGNAT (`100.64/10`), documentation ranges or multicast, including IPv4-mapped IPv6.
- Hosts outside the allowlist, including a redirect onto one.
- An HTML response (such as a sign-in page): "That link opened a web page, not a file."
- Bodies over 20 MB, or slower than 15 seconds.

No connector token is used: the request is a plain public fetch, so no token can reach the browser or a log.

## 3. Figure defaults

Figure size is in inches (`figureInches` in `packages/shared-types/src/plots.ts`):

| `figure` | Inches |
|---|---|
| `single` (default) | The stored width × height, 3.25 × 2.4 by default |
| `double` | 7 × 3.5 |
| `half` | 3.5 × 2.2 |
| `custom` | The stored width × height (1–12 in); typing a width or height in Export picks it |

The stored `preset` field (`icml`, `neurips`, `iclr`, `ensemble`) does not change the size. For reference, ICML columns are 3.25 in (one) and 6.75 in (two); NeurIPS and ICLR text is 5.5 in wide, so a 6.75 in figure does not fit them.

Matplotlib export (`apply_publication` in `ensemble_agent/plots/worker.py`, copied into `lib/plots/python-sources.ts`):

- Serif close to Times (Liberation Serif, Nimbus Roman, STIX, then DejaVu Serif) by default; **Figure font** switches to sans. Sizes in points: axis labels 9, ticks 8, legend 8, title 10.
- Lines 1.25 pt, light grid behind the data, top and right spines off, legend frame off.
- PDF and EPS embed TrueType fonts (`pdf.fonttype` and `ps.fonttype` 42); Type 3 fonts get figures rejected or blurred in proceedings builds.
- No "Figure 1" caption is drawn into the figure; captions belong in the paper.

Chart defaults (`PlotConfig`, `lib/plots/option.ts`):

- Markers on for a series of up to 24 points; off past that.
- Error bars and confidence bands drawn; bands at 22 % opacity (`BAND_ALPHA`) so the line stays primary.
- Legend below the axes; the user can move it.
- Palette **Okabe–Ito** (its black becomes a light neutral in dark theme, and back to black in paper export). Also Tableau 10, ColorBrewer Set2, viridis, RdBu and Accent. A chart with one series, and the Accent palette, use the app accent (`seriesColor`).
- Heatmaps use viridis, or RdBu when that palette is chosen.

The browser chart reads the shell's surface and text tokens (`apps/hub-web/lib/plots/theme.ts`, `components/plots/chart-view.tsx`) and observes `data-theme`, `data-color-theme` and accent styles, so changing the app palette repaints the chart without resetting the axes. Series colours and the Code editor theme are unaffected.

## 4. What the tab does

When Plots is off, `/plots` shows a blurred landing with Enable. Enabling adds the sidebar item, command-palette entries, a Saved plots tile on Today (with a skippable starter tour) and the assistant tools. Turning it off hides those and keeps the data.

1. **Add data:** drop, pick, paste, or paste a URL. Preview table with a type menu per column (number, date, category, text).
2. **Charts:** line, multi-line, area, stacked area; bar (grouped, stacked, 100 % stacked, horizontal or vertical); pie, donut; scatter, bubble; histogram, box, violin; heatmap; error bars and bands; step; waterfall; combo bar + line.
3. **Encodings:** X, one or many Y, colour-by, aggregation (sum, mean, count, median), sort, one filter, log scales.
4. **Dual Y:** each series is on the left or right axis, each with its own scale, title and log flag.
5. **Interaction:** tooltip, wheel zoom, box zoom, pan, reset, brush a range (offered as a filter), legend toggles a series, click a bar or slice to recolour it, crosshair.
6. **Style:** per-series colour, dash (solid, dashed, dotted, dash-dot), width, marker, opacity; title, subtitle, axis titles, tick format, legend position, grid, font size; palettes.
7. **Annotations:** horizontal line, vertical line, `y = mx + c`, shaded band, each with label, colour and dash. Not data.
8. **Export:** PNG at 1×, 2×, 4× or a DPI (72–600); SVG; CSV of the plotted (aggregated) rows; copy image; matplotlib source; matplotlib PDF, SVG, PNG and EPS rendered on the server (§5) or in the browser (§5a). The CSV comes from `tableToCsv` (`packages/shared-types/src/plots-parse.ts`), which CSV-escapes headers and cells containing commas, quotes or line breaks; the parser reads quoted multiline records back. *Settings › Data › Download this space* with Plots ticked adds each plot space's settings as JSON and its data as CSV; it does not render figures.
9. **Code view:** CodeMirror in Python mode, lazy-loaded, with the Code tab's shared theme picker (a change updates other open editors on the device). Below 768 px wide or 500 px tall it is view-only. The boilerplate calls `load` / `save`. **Run** (button, Ctrl/⌘+Enter or Shift+Enter) renders the script to PNG on the server (§5) or in the browser (§5a) and shows the figure under the code. **Figure beside code** (screens 1,024 px and wider; `useFigureBeside` in `figure-run.tsx`) and **Wrap lines** are kept per browser. A failure shows the message with its line ("Line 4: NameError: …", `scriptErrorLine` in `lib/plots/render.ts`) and marks that line (`components/plots/code-pane.tsx`). `plt.show()` and `save()` both capture the figure. The script is stored on the plot.
10. **Saved plots:** dataset id, config, style, annotations, optional code; autosave; duplicate. An `@` mention renders a card that opens the plot. Ask search returns plots when the module is on. Assistant tools create and edit plots like tasks (a write waits for Apply); `hub_import_dataset` makes a dataset from pasted CSV or from a CSV, TSV or `.xlsx` sheet in Files ([11](11_HOW_THE_ASSISTANT_WORKS.md)). The Context Bridge can read a plot and cannot write one.

## 5. Matplotlib and the sandbox

`ensemble_plots` is injected into the sandbox; it is not a PyPI package.

```python
from ensemble_plots import load, save
import matplotlib.pyplot as plt

df = load("sales")  # the dataset chosen in the plot, by the name the user sees
fig, ax = plt.subplots()
ax.plot(df["month"], df["revenue"])
save(fig)           # or plt.show()
```

`load` reads a JSON table copied into the run's temp directory. It does not accept a path. An unknown name raises a Python error listing the names that exist.

The sandbox is a short-lived child of the agent runtime (`ensemble_agent/plots/sandbox.py`, `worker.py`; hub-api's in-process sidecar is `runtime/plot-run.ts` and `plots-python.ts`):

- The working directory is a fresh temp dir, deleted after the run. Tracebacks refer to `user_script.py` line numbers.
- The environment is scrubbed (no proxy or cloud credentials). `MPLCONFIGDIR` (or `ENSEMBLE_MPLCONFIGDIR`) is a per-user cache so warm workers reuse fonts.
- CPU and file-size rlimits apply on macOS and Linux. `ENSEMBLE_PLOT_MEMORY_MIB` sets a 64–2048 MiB per-child budget (default 2048). Linux applies an address-space rlimit. macOS does not enforce that rlimit, so the parent samples resident memory with `libproc` and kills an oversized child's process group: a sampled budget, **not an instantaneous hard ceiling**. Low budgets must leave room for scientific imports. Windows has no memory limit here.
- Wall clock: 45 s for a cold start, 25 s warm (20 s warm on the hosted Linux path); the sidecar has its own budgets in `plots-python.ts`. Output is capped. At a limit the child's whole process group is killed.
- `ENSEMBLE_PLOT_CONCURRENCY` exports run at a time (default 2; use 1 on a 4 GB VM). An export queued behind others gives up after at most 110 s (`PLOT_QUEUE_WAIT_CAP_S`) with a busy reply, under Vercel's 120 s proxy cut; each export ahead counts at its own limit.
- An import hook refuses `socket`, `subprocess`, `ctypes`, `multiprocessing`, `pickle`, `http`, `ssl`, `urllib.request`, `requests`, `httpx` and similar. Allowed: numpy, pandas, matplotlib, seaborn, scipy and what they import.
- After the stack loads, socket connect, `os.system` and `subprocess` are replaced with functions that raise, and an audit hook refuses `open` outside the temp dir, the interpreter prefix and font directories.
- The runtime makes no network calls on the user's behalf during a run.

On macOS and in the desktop app (`plot_mode` = `sandbox`), the warm worker starts through hub-api's spawn choke point (`workspace/sandbox/cli.ts`), which applies Seatbelt. The profile grants only metadata for ancestors the interpreter's `realpath` needs plus read-only interpreter and worker files; no ancestor contents, sibling files, credentials or extra writes. Linux has no OS sandbox, so plots there use the in-process guards above. Start-up and queue failures return 503 with retry information, distinct from a script error.

Stale-directory cleanup skips directories still used as a process's working folder; when processes cannot be inspected it warns and deletes nothing.

This is a process sandbox, not a VM, and it does not need Docker, so it runs on macOS, Windows and Linux.

## 5a. In the browser (Ensemble on the web)

`GET /api/plots/runtime` returns `{ serverPython }`. When it is false, or a render answers 403 `HOST_ACCESS_DENIED`, the page runs the same script in the browser (`lib/plots/render.ts`, `lib/plots/browser-python.ts`):

- `GET /api/plots/:id/render-input` returns what the server's render would run: the datasets (`{ name, columns, rows }`, repeated names numbered) and the code (the plot's own or the generated one). Nothing runs on the server.
- Python is Pyodide 314.0.7 from `cdn.jsdelivr.net`: numpy, pandas, matplotlib and whatever the script imports (`loadPackagesFromImports`; seaborn via micropip). The first use downloads about 30 MB, which the browser caches; the page says so while it starts.
- The script runs with the runtime's own `ensemble_plots` module and the same steps as `worker.py` (temp folder, `datasets.json`, `user_script.py`, `PLOTS_FORMAT` / `PLOTS_DPI`, Agg backend, figure read back from `out/`). The result has the server's shape (`{ format, data, stdout, stderr }`; a failure gives the message and the line). `lib/plots/python-sources.ts` holds copies of `worker.py`'s `HELPER` and `parse_table.py`; a test keeps them byte-for-byte equal, and the driver is tested under CPython.
- **Isolation.** The script runs in a Web Worker. Before it runs, the worker permanently removes `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`, `Worker`, IndexedDB and cache storage from its scope and every prototype that defines them; a script that needs a package the worker did not load gets a fresh worker. A plot script, including one someone else wrote, has no network, storage, page or cookies, so it cannot send data anywhere or call Ensemble as the user. A run stops after 1 minute (3 minutes until the worker's first answer, for every request made before it).
- Spreadsheet readers run in a second worker that runs only Ensemble's own code.
- A worker starts Python once and handles one request at a time: a preview and a download asked for together share the download, and a plot cannot lock the network away while another request is still loading packages.
- The only cross-origin requests are the Pyodide downloads from `cdn.jsdelivr.net` (`pyodide.js` via `importScripts`; the WebAssembly module, lock file and packages via `fetch`). When one is blocked, the browser reports a bare network or CORS error; the page says Python could not be downloaded from jsDelivr and quotes the browser (`pythonFailure`). Figures and PNG exports are decoded in the page, not fetched.

## 6. Caching

Follows [CACHING.md](CACHING.md): keep caches small and drop them when the bytes change.

- Parsed tables are not in Redis. Each is a blob (or a file on disk) plus a Postgres metadata row.
- One in-process LRU in hub-api (`plots/cache.ts`) holds up to 8 parsed tables, at most 64 MB together, for 10 minutes, keyed by dataset id and content hash. Export, matplotlib and the mention card reread the same table during an editing session; a read served from the cache does not touch the store. Replacing or deleting a dataset drops its entry.
- Chart config is a small JSON column and is not cached.
- The browser keeps the open table in memory for the studio only.

## 7. Performance

ECharts and CodeMirror are dynamic imports from the studio and the code pane; the Plots list page does not import them. Loaders use `useDelayedFlag`, so a fast parse does not flash a spinner. Desk tiles do not import ECharts; the Saved plots tile is a list of links.

## 8. Tiled workspace

The main surface is a **plot space**: a canvas of chart tiles (`components/plots/workspace.tsx`). An account can create, name and switch between several plot spaces; each is stored as a plot whose config has `kind: "workspace"` (routes in §9). Layout and tile config autosave, and switching saves the current space first. Renaming patches only the title, so it cannot overwrite a queued layout save. `/plots/<space-id>` redirects to `/plots?space=<id>`. A plot space lives inside one Ensemble space ([28](28_ENSEMBLE_SPACES.md)); it organises charts and files and is not a context-isolation boundary. A saved single plot still opens in the studio.

### Packing

A **12-column grid with vertical compaction** (the Grafana rule; `packages/shared-types/src/plots-pack.ts`). Each tile stores `col`, `row`, `w`, `h`; minimum 3 × 3 so a tile cannot collapse into an unreadable sliver. A gutter separates tiles. The chart is clipped to its tile, and a `ResizeObserver` calls `chart.resize()` (throttled to one animation frame), also while the tile is dragged or resized. During a gesture the other tiles reflow to their packed cells and a dashed ghost marks the target cell; on pointer-up that packing is saved. Overlapping tiles are pushed down, then every tile moves up until it meets another tile or the top. The column is left alone, so a tile parked on the right stays there.

- **Click** selects a tile and opens quick edit on it (title, series colour, line style).
- **Double-click, Open or Enter** expands it into the focused editor: the chart plus encode, style, lines, code, export and axis side per series. Hover shows resize handles, Open and Delete.
- **Keyboard**, with the tile focused: arrows move it one cell, Shift+arrows resize, Delete removes (with a toast Undo that puts it back in a free position), Enter opens. Controls inside a tile keep their normal keys. Escape closes the editor; a nested popover takes Escape first.
- Below 768 CSS px the focused editor stacks the chart above a full-width scrolling settings panel, hides the width grip and keeps Back reachable (`components/plots/focus-editor.tsx`). Settings tabs use Left/Right, Home and End.

### Adding a tile

Add tile opens a gallery of chart types, grouped into Paper figures and Everyday charts, each with its own small preview. The next step is one searchable list of columns from every dataset on the workspace, where the user picks X and Y; the flow never asks which file. A column's type is always shown; its file name only when the column name is not unique.

### Uploads belong to the workspace

The **Add data** dialog takes a drop, a file from **Choose a file**, a public Sheets, Drive, OneDrive or SharePoint link, a paste, and the formats in §2. Progress is a percentage: reading the file, scanning a text file for rows, then the upload request (`loaded / total`); it reaches 100 when the server returns the column list. A link fetched by the server has no byte events, so the bar holds its last value until the response.

The next screen lists the file name, row count, columns and detected types, each overridable. OK keeps the dataset on the workspace; Cancel deletes it.

### Duplicate column names

Columns are **separate by default**, labelled with their file only when names collide. The shared-name choice is **per name** and appears only when a name collides: in the upload summary, and afterwards from a dismissible **Shared columns** chip in the toolbar (hidden when nothing collides). One switch for every duplicate would join a key and a measure alike and hide type mismatches.

- **Keep separate:** two pool entries (`time` from `train.csv`, `time` from `eval.csv`). Right for two measures that share a name.
- **Join on this column:** offered only when every copy has the same type (otherwise disabled with the reason). Tiles can then plot a measure from one file against one from another, inner-joined on that key.

A pool entry is stored as a dataset id (or a join) plus the column name, separated by a unit separator (`\u001f`, `packages/shared-types/src/plots-pool.ts`); Postgres cannot store a null byte inside JSON.

### Paper figures

Gallery entries, not a second chart engine:

| Gallery entry | Use | Chart |
|---|---|---|
| Training curve | Mean over seeds, shaded standard deviation | Line, error as a band |
| Ablation bars | Grouped bars with error bars | Bar, error as bars |
| Scaling law | Loss against compute or data | Line, both axes logarithmic |
| Pareto front | Two objectives, one point per run | Scatter |
| Confusion matrix | Class against class | Heatmap |
| Reliability | Confidence against accuracy, with the diagonal | Line plus `y = x` |
| Run distribution | Spread across seeds | Violin |

A training curve wants a step, a measure and an optional seed: per-seed rows are averaged and the sample standard deviation shaded. An ablation wants a mean and an error column.

An empty space starts with **Upload a table**; there is no sample-data action. Image grids are not a tile type (the importers do not carry images).

Export of one tile draws that tile's script. **Export figure** for the canvas (`components/plots/export-dialog.tsx`) shows a large preview and offers width and height in inches (default 7 × at least 4.2), DPI (default 150; the preview uses at most 150), font size, 1–3 columns, a shared legend, panel order, and PDF, SVG, PNG or EPS. The script plots each tile's table, including a join, so the file matches the canvas; box, violin and confusion-matrix tiles are drawn as such. Panel labels `(a)`, `(b)`, … sit outside the top-left of each axes.

### Code on the canvas

`load(name)` resolves every dataset on the workspace by its visible name (a repeated name is numbered, `runs 2`, as `render-input` numbers it). `save()` captures the figure. No file path is shown. Both Code panels have **Run** with the figure under the code or, with **Figure beside code**, beside it (§4 item 9). Scripts come from `apps/hub-web/lib/plots/tile-code.ts`.

- **A tile's Code tab** (in the focused editor) shows the matplotlib that draws that tile from its settings: its series and marks (line, bar, scatter, area, step, box, violin, heatmap, histogram, pie), error bars or bands, seed mean and std, axis labels, title, colours, ticks and legend (`matplotlibSource` in `packages/shared-types/src/plots-matplotlib.ts`). It loads the tile's file by name; a tile joined across files has its rows written into the script. The run's figure fills the editor's preview, with a Chart / Code output switch.
- **Editing it** stores the text on the tile (`code`, up to 40,000 characters). From then on the tile's export and its Export figure panel draw that code; Encode and Style still change the canvas chart but not the code, and both tabs say so. The tile shows a small **Code** mark. **Reset to generated**, or typing the generated text back, clears the edit.
- **The canvas Code view** (toolbar **Code**) is a full-width editor that starts from every tile as one panel figure, with files loaded by name (rows written in only for a join or a seed summary); with no drawable tile it starts from the first file's first two columns. Edits are saved as the plot space's `code`; Reset to generated clears them.
- **Export figure** with edited canvas code offers a choice, starting on **your edited canvas code** (the script as it is, with its own size and layout, so only DPI applies) or **the tiles**. A tile with edited code is drawn from its code either way: the panel is that script's figure, run with its style changes undone afterwards, and the dialog names those tiles. In PDF, SVG and EPS such a panel is a picture at the chosen DPI; the tile's own Export gives the vector file. A failure in a tile's code names the panel and its line.

`apps/hub-web/lib/plots/tile-code.test.ts` renders every sample tile's generated script, a violin, and a canvas figure with an edited tile through the browser's driver under the agent runtime's Python.

### Plots inside pages

The `@` menu has one Plots category. `@plots:` browses named spaces, then their tiles; saved single plots are under Saved plots. Uploaded tables appear as data-file mentions, found through `@plot:<name>` or `@plots:<name>`. Tile identity includes the space id, so identical tile titles do not select the wrong chart. The entity endpoint is user-scoped and leaves this out when Plots is off.

An inline `@ensemble` request can use a dataset mention to create a saved plot and attach it below its answer. `components/plots/plot-card.tsx` renders real ECharts charts for saved plots and workspace tiles. The embed is page-width, follows the chart's proportions until resized, and has compact/expand and remove controls. Its bottom bar resizes the height (drag or arrow keys, 180 px minimum); the height is saved on the mention. Removing it (or Backspace) changes only the document; the saved chart and its files remain.

## 9. API

`apps/hub-api/src/routes/plots.ts`. The routes are classed `shared` in `sharing/policy.ts`: members of a shared Ensemble space use them like other shared content, and one plot or plot space can be shared on its own (`plot`, `plot_space`; view reads, edit saves) ([29](29_SHARING.md)). Dataset ids in a workspace config are ownership-checked on create and save.

| Method | Path | What |
|---|---|---|
| GET, POST | `/api/plots` | List; create `{ title?, datasetId?, config? }` (a workspace config creates a plot space) |
| GET, PUT | `/api/plots/workspace` | Open (`?id=`) or save `{ id?, config, code?, title? }` a plot space; without `id`, the most recent |
| GET, PATCH, DELETE | `/api/plots/:id` | One plot; a workspace config is returned as it is |
| POST | `/api/plots/:id/duplicate` | Copy a plot |
| POST | `/api/plots/:id/export.csv` | `{ csv, filename }` of the plotted rows |
| POST | `/api/plots/:id/matplotlib` | `{ code }`, the generated source |
| GET | `/api/plots/runtime` | `{ serverPython }` |
| GET | `/api/plots/:id/render-input` | The datasets and code a render would run (§5a) |
| POST | `/api/plots/:id/render` | Run on the server: `png`, `svg`, `pdf` or `eps`. Hosted, operator only |
| GET, POST | `/api/plots/datasets` | List; import a file, paste, link or explicit table (body up to 34 MB) |
| GET, PATCH, DELETE | `/api/plots/datasets/:id` | One dataset (`?rows=1`, `?preview=` up to 200 rows); rename or set column types |
| POST | `/api/plots/datasets/:id/sheet` | Pick another sheet of a kept workbook |
