---
name: plots
title: Plots and charts
when: charts and plots from a file in Files, a dataset, a table in a page or numbers pasted in chat; bar, line, scatter, histogram, box, heatmap, pie and combo charts; changing an existing plot
tools: hub_list_datasets, hub_get_dataset, hub_import_dataset, hub_list_plots, hub_get_plot, hub_create_plot, hub_update_plot, hub_list_files, hub_read_file, hub_manage_record
module: plots
match: \b(plots?|charts?|graphs? of|bar (chart|graph|plot)|histograms?|scatter|line (chart|graph|plot)|pie|donut|heat ?map|box ?plot|violin|waterfall|visuali[sz]e|datasets?|trend)\b
paths: /plots
mentions: plot, dataset
---
A plot is drawn from a dataset (a table in Plots). Steps: get the data in, read its columns, then create the plot. Plot writes wait for Apply.

1. Get the data
- Already a dataset: hub_list_datasets (query), or the dataset id from a mention.
- A CSV, TSV or Excel file in Files: hub_list_files → hub_import_dataset with fileId (and sheet for a workbook with several tabs). Do not read the whole file into chat first.
- Numbers in the message or a table on a page: hub_import_dataset with name and text as CSV (header row first, one row per line).
2. Read the columns: hub_get_dataset → column names and types (number, date, category, text) and preview rows. Use those exact column names.
3. Create: hub_create_plot with title, datasetId and config. Change one later: hub_get_plot → hub_update_plot with only the fields to change.

Choosing the chart (config.chart)
- Compare categories: "bar" (or "bar-horizontal" for long names); parts of a whole per category: "stacked-bar" / "stacked-bar-100".
- Over time: "line", "area", "stacked-area", "step". Two measures with different units: "combo" with series marks bar/line and axis left/right.
- Relationship between two numbers: "scatter"; a third number as size: "bubble".
- Distribution of one number: "histogram" (binCount), "box" or "violin" per category (x = the category).
- Share of a total, few categories: "pie" or "donut".
- Matrix of two categories and a value: "heatmap". Running total of gains and losses: "waterfall".

Config fields that matter
- x: the x column. series: [{ "y": column, "axis": "left" | "right", "agg": "sum" | "mean" | "count" | "median", "mark": "bar" | "line" }]. colorBy: a category column to split series.
- agg (whole plot), sort ("x-asc", "y-desc"…), filter { column, op: eq | contains | gt | lt, value }.
- title, subtitle, xTitle, yTitleLeft, yTitleRight, legend (top, bottom, left, right, none), yLogLeft, xTickRotate (−45 for long labels), palette (okabe-ito, tableau10, set2, viridis, rdbu, accent).
- annotations: hline (a target), vline (a date), band, linear (a trend line).

Examples
- "Bar chart of revenue by region from sales.xlsx" → hub_list_files "sales" → hub_import_dataset fileId → hub_get_dataset → hub_create_plot { chart: "bar", x: "Region", series: [{ y: "Revenue", agg: "sum" }], sort: "y-desc", title: "Revenue by region" }.
- "Monthly signups vs churn rate" → combo: series [{ y: "Signups", mark: "bar" }, { y: "Churn rate", mark: "line", axis: "right" }].
- "Distribution of response times by service" → box: x "Service", series [{ y: "Response ms" }].

Rules
- Never invent columns or numbers. If a needed column is missing, say which and ask.
- One plot per request unless they asked for several.

Other record maintenance → hub_manage_record (restore one trashed record, page/task conversion, supported plot/diagram/dataset actions, file tags and internal comments). Use the relevant real ID; it preserves the app's existing access and deletion rules.
