/**
 * Plots in the browser (docs/02 Plots): the plot runtime's Python is the same in the browser as on
 * the server, a render falls back to the browser exactly when the server refuses, and the browser's
 * driver draws the same figures and reads the same tables. The driver runs here under the agent
 * runtime's own Python (CPython, with the same libraries Pyodide ships); without it those tests skip.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApiError, api } from "@/lib/api";
import { DRIVER_PY, pythonFailure } from "./browser-python";
import { PARSE_TABLE_PY, PLOT_HELPER } from "./python-sources";
import { forgetPlotRuntime, PlotScriptError, renderPlot, scriptErrorLine } from "./render";

const runtime = join(process.cwd(), "..", "agent-runtime");

test("the browser's plot helper and table reader are the plot runtime's own, byte for byte", () => {
  const worker = readFileSync(join(runtime, "ensemble_agent", "plots", "worker.py"), "utf8");
  const helper = /HELPER = '''([\s\S]*?)'''/.exec(worker)?.[1];
  assert.equal(PLOT_HELPER, helper, "copy worker.py's HELPER into lib/plots/python-sources.ts");
  assert.equal(PARSE_TABLE_PY, readFileSync(join(runtime, "ensemble_agent", "plots", "parse_table.py"), "utf8"), "copy parse_table.py into lib/plots/python-sources.ts");
});

test("a render runs on the server where it may, and in the browser exactly when the server refuses", async () => {
  const original = { runtime: api.plotRuntime, render: api.renderPlotOnServer, input: api.plotRenderInput };
  const calls: string[] = [];
  const datasets = [{ name: "runs", columns: ["x", "y"], rows: [[1, 2]] }];
  const runner = async (job: { code: string; format: string }) => {
    calls.push(`browser:${job.format}:${job.code}`);
    return { format: job.format as "png", data: "PNG", stdout: "", stderr: "", line: null };
  };
  try {
    forgetPlotRuntime();
    api.plotRuntime = async () => ({ serverPython: true });
    api.renderPlotOnServer = async () => {
      calls.push("server");
      return { format: "png", data: "SERVER", stdout: "", stderr: "" };
    };
    assert.equal((await renderPlot("p", { format: "png", code: "x" }, runner as never)).data, "SERVER");

    forgetPlotRuntime();
    api.renderPlotOnServer = async () => {
      calls.push("server-refused");
      throw new ApiError("Python plots is available only to the hosted Ensemble operator.", 403, "HOST_ACCESS_DENIED");
    };
    api.plotRenderInput = async () => ({ code: "default code", datasets });
    assert.equal((await renderPlot("p", { format: "png", code: "mine" }, runner as never)).data, "PNG");
    assert.equal((await renderPlot("p", { format: "svg" }, runner as never)).data, "PNG", "the server is not asked again");
    assert.deepEqual(calls.slice(1), ["server-refused", "browser:png:mine", "browser:svg:default code"]);

    forgetPlotRuntime();
    api.renderPlotOnServer = async () => {
      throw new ApiError("The script failed.", 400);
    };
    await assert.rejects(renderPlot("p", { format: "png", code: "x" }, runner as never), /The script failed/, "a script error is not a reason to run it elsewhere");

    forgetPlotRuntime();
    api.plotRuntime = async () => ({ serverPython: false });
    const failing = async () => ({ format: "png" as const, data: null, stdout: "", stderr: 'File "user_script.py", line 3\nNameError: x', line: 3, error: "NameError: x" });
    await assert.rejects(renderPlot("p", { format: "png", code: "x" }, failing as never), (error: unknown) => error instanceof PlotScriptError && error.line === 3 && /^Line 3: NameError/.test(error.message));
    assert.equal(scriptErrorLine("Line 3: NameError: x"), 3, "the server's 400 says the line the same way");
    assert.equal(scriptErrorLine("The script hit the CPU limit."), null);
  } finally {
    api.plotRuntime = original.runtime;
    api.renderPlotOnServer = original.render;
    api.plotRenderInput = original.input;
    forgetPlotRuntime();
  }
});

test("a blocked Python download says where Python comes from; other failures pass through", () => {
  assert.match(pythonFailure("TypeError: Network response is CORS-cross-origin"), /could not be downloaded from cdn\.jsdelivr\.net.*CORS-cross-origin$/);
  assert.match(pythonFailure("NetworkError: Failed to execute 'importScripts' on 'WorkerGlobalScope'"), /cdn\.jsdelivr\.net/);
  assert.equal(pythonFailure("Unknown request."), "Unknown request.");
});

const python = join(runtime, ".venv", "bin", "python");
const pythonReady = existsSync(python) && spawnSync(python, ["-c", "import matplotlib, pandas, openpyxl, pyarrow"]).status === 0;

/** Runs a function of the browser driver under CPython, as Pyodide would. */
function driver(call: string): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), "plots-driver-"));
  writeFileSync(join(dir, "ensemble_driver.py"), DRIVER_PY);
  writeFileSync(join(dir, "ensemble_parse_table.py"), PARSE_TABLE_PY);
  writeFileSync(join(dir, "helper.txt"), PLOT_HELPER);
  const script = `import sys, json\nsys.path.insert(0, ${JSON.stringify(dir)})\nimport ensemble_driver as d\nhelper = open(${JSON.stringify(join(dir, "helper.txt"))}).read()\nprint(${call})`;
  const out = execFileSync(python, ["-c", script], { encoding: "utf8", env: { ...process.env, MPLBACKEND: "Agg" } });
  return JSON.parse(out.trim().split("\n").pop()!) as Record<string, unknown>;
}

test("the browser's driver draws a plot from a dataset with the helper, and reports a failing line", { skip: !pythonReady && "the agent runtime's Python is not installed here" }, () => {
  const job = (code: string, format: string) =>
    JSON.stringify(JSON.stringify({ code, format, dpi: 72, datasets: [{ name: "runs data", columns: ["step", "loss"], rows: [[1, 0.9], [2, 0.5], [3, 0.3]] }] }));
  const code = "from ensemble_plots import load, save\nimport matplotlib.pyplot as plt\nframe = load('runs data')\nprint(len(frame))\nplt.plot(frame['step'], frame['loss'])\nsave()\n";
  const png = driver(`d.run_plot(${job(code, "png")}, helper)`);
  assert.equal(png.error, undefined, String(png.stderr));
  assert.equal(Buffer.from(String(png.data), "base64").subarray(1, 4).toString(), "PNG");
  assert.equal(String(png.stdout).trim(), "3");
  const svg = driver(`d.run_plot(${job(code, "svg")}, helper)`);
  assert.match(String(svg.data), /<svg/);
  const broken = driver(`d.run_plot(${job("x = 1\ny = 2\nprint(missing)\n", "png")}, helper)`);
  assert.equal(broken.data, null);
  assert.equal(broken.line, 3);
  assert.match(String(broken.error), /NameError/);
});

test("the browser's driver reads an Excel sheet and a Parquet file with the plot runtime's reader", { skip: !pythonReady && "the agent runtime's Python is not installed here" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "plots-tables-"));
  const xlsx = join(dir, "book.xlsx");
  const parquet = join(dir, "table.parquet");
  execFileSync(python, ["-c", `import pandas as pd\nwith pd.ExcelWriter(${JSON.stringify(xlsx)}) as w:\n    pd.DataFrame({"name": ["a", "b"], "value": [1.5, 2]}).to_excel(w, sheet_name="First", index=False)\n    pd.DataFrame({"other": [1]}).to_excel(w, sheet_name="Second", index=False)\npd.DataFrame({"x": [1, 2, 3]}).to_parquet(${JSON.stringify(parquet)})`]);
  const read = (path: string, sheet = "") => driver(`d.parse(${JSON.stringify(path.split("/").pop())}, open(${JSON.stringify(path)}, "rb").read(), ${JSON.stringify(sheet)})`);
  const book = read(xlsx);
  assert.deepEqual(book.sheets, ["First", "Second"]);
  assert.deepEqual((book.columns as Array<{ name: string }>).map((column) => column.name), ["name", "value"]);
  assert.deepEqual(book.rows, [["a", 1.5], ["b", 2]]);
  assert.deepEqual(read(xlsx, "Second").rows, [[1]]);
  const table = read(parquet);
  assert.deepEqual(table.rows, [[1], [2], [3]]);
  assert.deepEqual(table.columns, [{ name: "x", type: "number" }]);
});
