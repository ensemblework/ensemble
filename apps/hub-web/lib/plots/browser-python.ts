/**
 * Python in the browser for Plots (Ensemble on the web, docs/02 Plots), with Pyodide from jsDelivr.
 *
 * Two workers. The plot worker runs the person's plot code: it loads what the code imports, then cuts
 * itself off from the network and from storage (fetch, XMLHttpRequest, WebSocket, importScripts,
 * Worker, IndexedDB, caches) before the code runs, and stays that way; code that needs a package it
 * did not load gets a fresh worker. So a plot script, even one someone else wrote, cannot send the
 * data anywhere or act as you. The parse worker reads spreadsheets and Arrow files with the plot
 * runtime's own reader and runs no one's code but ours.
 *
 * The first use downloads Python and its plotting packages (about 30 MB); the browser keeps them.
 */
import { useSyncExternalStore } from "react";
import { PARSE_TABLE_PY, PLOT_HELPER } from "./python-sources";

export const PYODIDE_VERSION = "314.0.7";
export const PYODIDE_INDEX = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

const FIRST_MS = 180_000;
const RUN_MS = 60_000;

/** Runs a plot the way the plot worker on the server does (worker.py `_prepare` / `_payload`), and reads tables. */
export const DRIVER_PY = String.raw`
import base64, io, json, logging, os, shutil, sys, traceback
from pathlib import Path

MAX_OUTPUT = 16_000


def _line(stderr):
    for row in reversed(stderr.splitlines()):
        if "user_script.py" in row and "line" in row:
            digits = "".join(ch if ch.isdigit() else " " for ch in row).split()
            if digits:
                return int(digits[-1])
    return None


def _summary(stderr):
    lines = [line for line in stderr.splitlines() if line.strip()]
    return lines[-1][:500] if lines else ""


def imports(code):
    from pyodide.code import find_imports
    return json.dumps([name for name in find_imports(code) if name != "ensemble_plots"])


def missing(names_json):
    import importlib.util
    return json.dumps([name for name in json.loads(names_json) if importlib.util.find_spec(name) is None])


def run_plot(job_json, helper):
    import tempfile
    job = json.loads(job_json)
    root = Path(tempfile.mkdtemp(prefix="ensemble-plot-"))
    (root / "out").mkdir(parents=True)
    (root / "ensemble_plots.py").write_text(helper)
    mapping = {}
    for item in job.get("datasets") or []:
        name = str(item.get("name") or "data")
        safe = "".join(ch if ch.isalnum() else "_" for ch in name)[:40] or "data"
        filename = f"{safe}.json"
        columns = list(item.get("columns") or [])
        records = []
        for row in item.get("rows") or []:
            cells = list(row) if isinstance(row, (list, tuple)) else []
            records.append({str(column): (cells[index] if index < len(cells) else None) for index, column in enumerate(columns)})
        (root / filename).write_text(json.dumps(records))
        mapping[name] = filename
    (root / "datasets.json").write_text(json.dumps(mapping))
    (root / "user_script.py").write_text(str(job.get("code") or ""))
    fmt = str(job.get("format") or "png")
    dpi = int(job.get("dpi") or 200)
    os.environ.update({"HOME": str(root), "PLOTS_ROOT": str(root), "PLOTS_FORMAT": fmt, "PLOTS_DPI": str(dpi), "MPLBACKEND": "Agg"})
    import matplotlib
    matplotlib.use("Agg")
    logging.getLogger("matplotlib.font_manager").setLevel(logging.ERROR)
    import matplotlib.pyplot as plt
    plt.close("all")
    matplotlib.rcdefaults()
    matplotlib.use("Agg")
    sys.modules.pop("ensemble_plots", None)
    before = os.getcwd()
    os.chdir(root)
    sys.path.insert(0, str(root))
    out, err = io.StringIO(), io.StringIO()
    saved = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out, err
    failed = False
    try:
        code = (root / "user_script.py").read_text()
        exec(compile(code, "user_script.py", "exec"), {"__name__": "__main__"})
    except SystemExit as stop:
        failed = stop.code not in (None, 0)
    except BaseException:
        traceback.print_exc()
        failed = True
    finally:
        sys.stdout, sys.stderr = saved
        os.chdir(before)
        if str(root) in sys.path:
            sys.path.remove(str(root))
        plt.close("all")
    stdout = out.getvalue()[-MAX_OUTPUT:]
    stderr = err.getvalue()[-MAX_OUTPUT:]
    path = root / "out" / f"figure.{fmt}"
    data = None
    if path.exists() and path.stat().st_size:
        data = path.read_text() if fmt == "svg" else base64.b64encode(path.read_bytes()).decode("ascii")
    result = {"format": fmt, "data": data, "stdout": stdout, "stderr": stderr, "line": _line(stderr)}
    if failed and data is None:
        result["error"] = _summary(stderr) or "The script failed."
    shutil.rmtree(root, ignore_errors=True)
    return json.dumps(result)


def parse(filename, data, sheet):
    from ensemble_parse_table import parse_table
    raw = data.to_bytes() if hasattr(data, "to_bytes") else bytes(data)
    return json.dumps(parse_table(filename, raw, sheet or ""))
`;

/** The worker's own code: boots Pyodide, and for plot jobs locks the network away before running them. */
const WORKER_JS = String.raw`
let booting = null;
let locked = false;
let queue = Promise.resolve();
const NETWORK = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "Worker", "SharedWorker", "indexedDB", "caches", "BroadcastChannel", "WebTransport"];
const PURE = ["seaborn"];

// One start, shared by every request that arrives while Python is still downloading.
function boot(index, driver, parseTable) {
  if (!booting) {
    booting = (async () => {
      importScripts(index + "pyodide.js");
      const py = await loadPyodide({ indexURL: index });
      py.FS.mkdirTree("/ensemble");
      py.FS.writeFile("/ensemble/ensemble_driver.py", driver);
      py.FS.writeFile("/ensemble/ensemble_parse_table.py", parseTable);
      py.runPython("import sys\nsys.path.insert(0, '/ensemble')");
      return py;
    })();
    booting.catch(() => { booting = null; });
  }
  return booting;
}

// Gone for good from this worker: own properties and every prototype that defines them.
function lockdown() {
  for (let scope = self; scope; scope = Object.getPrototypeOf(scope)) {
    for (const name of NETWORK) {
      if (Object.getOwnPropertyDescriptor(scope, name)) {
        try { delete scope[name]; } catch (_) {}
      }
    }
  }
  for (const name of NETWORK) {
    try { Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false }); } catch (_) {}
  }
  locked = true;
}

// One request at a time: a plot locks the network away, which must not happen while another request is still loading packages.
self.onmessage = (event) => {
  queue = queue.then(() => handle(event));
};

async function handle(event) {
  const msg = event.data;
  const reply = (body) => self.postMessage(Object.assign({ id: msg.id }, body));
  try {
    const py = await boot(msg.index, msg.driver, msg.parseTable);
    const driver = py.pyimport("ensemble_driver");
    if (msg.type === "plot") {
      const wanted = driver.imports(msg.job.code);
      if (!locked) await py.loadPackage(["numpy", "pandas", "matplotlib", "micropip"]);
      let missing = JSON.parse(driver.missing(wanted));
      if (missing.length) {
        if (locked) return reply({ fresh: true });
        await py.loadPackagesFromImports(msg.job.code);
        missing = JSON.parse(driver.missing(wanted)).filter((name) => PURE.includes(name));
        if (missing.length) await py.pyimport("micropip").install(missing);
      }
      if (!locked) lockdown();
      return reply({ result: JSON.parse(driver.run_plot(JSON.stringify(msg.job), msg.helper)) });
    }
    if (msg.type === "parse") {
      const name = String(msg.filename).toLowerCase();
      await py.loadPackage(["pandas", "micropip"]);
      if (/\.(parquet|feather|arrow)$/.test(name)) await py.loadPackage(["pyarrow"]);
      if (/\.xls$/.test(name)) await py.loadPackage(["xlrd"]);
      if (/\.(xlsx|xlsm)$/.test(name)) await py.pyimport("micropip").install(["openpyxl"]);
      if (/\.ods$/.test(name)) await py.pyimport("micropip").install(["odfpy"]);
      return reply({ result: JSON.parse(driver.parse(msg.filename, msg.bytes, msg.sheet || "")) });
    }
    reply({ error: "Unknown request." });
  } catch (error) {
    reply({ error: String(error && error.message ? error.message : error).slice(-2000) });
  }
}
`;

type Status = "idle" | "loading" | "ready";
let status: Status = "idle";
const listeners = new Set<() => void>();
function setStatus(next: Status) {
  if (status === next) return;
  status = next;
  for (const listener of listeners) listener();
}

/** "loading" while Python is first downloaded and started in this tab. */
export function usePythonStatus(): Status {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => status,
    () => "idle",
  );
}

/** `ready` once the worker has answered: until then every request waits on the download, which gets the longer limit. */
type Slot = { worker: Worker; used: boolean; ready: boolean };
const slots: Partial<Record<"plot" | "parse", Slot>> = {};
let nextId = 0;

function slot(kind: "plot" | "parse"): Slot {
  let current = slots[kind];
  if (!current) {
    const url = URL.createObjectURL(new Blob([WORKER_JS], { type: "text/javascript" }));
    current = { worker: new Worker(url), used: false, ready: false };
    slots[kind] = current;
  }
  return current;
}

function drop(kind: "plot" | "parse") {
  slots[kind]?.worker.terminate();
  delete slots[kind];
}

type Reply = { result?: unknown; fresh?: boolean; error?: string };

function call(kind: "plot" | "parse", message: Record<string, unknown>): Promise<Reply> {
  const current = slot(kind);
  const starting = !current.ready;
  if (!current.used) setStatus("loading");
  current.used = true;
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      drop(kind);
      reject(new Error(starting ? "Python took too long to start in this browser. Try again." : "The script ran longer than a minute."));
    }, starting ? FIRST_MS : RUN_MS);
    const onMessage = (event: MessageEvent<Reply & { id: number }>) => {
      if (event.data.id !== id) return;
      cleanup();
      current.ready = true;
      setStatus("ready");
      resolve(event.data);
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      drop(kind);
      reject(new Error(event.message || "Python stopped in this browser."));
    };
    const cleanup = () => {
      clearTimeout(timer);
      current.worker.removeEventListener("message", onMessage);
      current.worker.removeEventListener("error", onError);
    };
    current.worker.addEventListener("message", onMessage);
    current.worker.addEventListener("error", onError);
    current.worker.postMessage({ id, index: PYODIDE_INDEX, driver: DRIVER_PY, parseTable: PARSE_TABLE_PY, helper: PLOT_HELPER, ...message });
  });
}

/**
 * The worker's own failures are downloading or starting Python (a script's errors come back in its
 * result). A blocked download reads as a bare network or CORS error, so say where it came from.
 */
export function pythonFailure(message: string): string {
  const text = message.trim();
  if (!/CORS|cross-origin|NetworkError|Failed to fetch|Load failed|importScripts|network/i.test(text)) return text;
  return `Python for Plots could not be downloaded from cdn.jsdelivr.net in this browser. A content blocker, a network filter or a browser setting may be blocking it. The browser said: ${text.split("\n").filter(Boolean).pop() ?? text}`;
}

export type PlotJob = { code: string; datasets: Array<{ name: string; columns: string[]; rows: Array<Array<string | number | null>> }>; format: "png" | "svg" | "pdf" | "eps"; dpi?: number };
export type PlotResult = { format: PlotJob["format"]; data: string | null; stdout: string; stderr: string; line: number | null; error?: string };

/** Runs a plot script in this browser; the result has the shape the server's render gives. */
export async function runPlotInBrowser(job: PlotJob): Promise<PlotResult> {
  let reply = await call("plot", { type: "plot", job: { ...job, dpi: job.dpi ?? 200 } });
  if (reply.fresh) {
    // The script needs a package this worker did not load before it locked itself down.
    drop("plot");
    reply = await call("plot", { type: "plot", job: { ...job, dpi: job.dpi ?? 200 } });
  }
  if (reply.error) throw new Error(pythonFailure(reply.error));
  return reply.result as PlotResult;
}

export type ParsedTable = { columns: Array<{ name: string; type: string }>; rows: Array<Array<string | number | null>>; sheets: string[]; sheet: string; warnings: string[] };

/** Reads a spreadsheet or Arrow file in this browser with the plot runtime's own reader. */
export async function parseTableInBrowser(filename: string, bytes: Uint8Array, sheet = ""): Promise<ParsedTable> {
  if (/\.numbers$/i.test(filename)) throw new Error("Numbers files cannot be read in the browser. In Numbers, choose File → Export To → Excel or CSV, and add that file.");
  const reply = await call("parse", { type: "parse", filename, bytes, sheet });
  if (reply.error) throw new Error(pythonFailure(reply.error.split("\n").filter(Boolean).pop() ?? "Could not read that file."));
  return reply.result as ParsedTable;
}
