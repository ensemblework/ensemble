/** Matplotlib stays on the person's python3. A missing interpreter is a plain 503. */
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import "./test-env.js";
import { RuntimeError, runtime } from "../lib/runtime.js";
import { HOSTED_PLOT_RUNTIME_DOWN, OPENING_NEEDS_PYTHON, PLOTS_NEED_PYTHON, plotExportErrorReply, plotRenderFailure, tableParseFailure } from "./plot-failure.js";
import { parsePlotConcurrency } from "./plot-concurrency.js";
import { fetchHostedPlotRun, PLOT_QUEUE_LIMIT_MS } from "./plot-run.js";
import { matplotlibCacheDir, plotConcurrency, plotWorkerEnv, PLOT_QUEUE_WAIT_CAP_S, pythonReadPaths, queueStartDelay, resetPlotWorker, setPlotQueueSlackForTests, setPlotQueueWaitCapForTests, setPlotWorkerPathForTests, submitPlot } from "./plot-worker.js";
import { FIRST_PLOT_TIMEOUT_MS, PLOT_EXPORTS_BUSY, PLOT_RUNTIME_UNAVAILABLE, PLOT_TIMEOUT_MS, resetPlotWarmupForTests, runPlot, setPlotRunnerForTests } from "./plots-python.js";
import { setPythonInterpreterForTests } from "./python-spawn.js";
import { CallError } from "./errors.js";

test("plot render is 503 when python3 is missing", async () => {
  process.env.ENSEMBLE_INPROCESS_RUNTIME = "1";
  setPythonInterpreterForTests(() => null);
  try {
    await assert.rejects(
      () => runtime("/api/plots/run", { method: "POST", json: { code: "print(1)", datasets: [{ name: "data", columns: ["a"], rows: [[1]] }] } }),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeError);
        assert.equal(error.statusCode, 503);
        assert.equal(error.message, PLOT_RUNTIME_UNAVAILABLE);
        const body = plotRenderFailure(error);
        assert.equal(body.error, PLOTS_NEED_PYTHON);
        assert.equal(body.retry, false);
        assert.equal(/agent runtime/i.test(body.error), false);
        return true;
      },
    );
  } finally {
    setPythonInterpreterForTests(null);
  }
});

test("binary table parse names Python when the interpreter is missing", async () => {
  process.env.ENSEMBLE_INPROCESS_RUNTIME = "1";
  setPythonInterpreterForTests(() => null);
  try {
    await assert.rejects(
      () =>
        runtime("/api/plots/parse", {
          method: "POST",
          json: { filename: "book.xlsx", contentBase64: Buffer.from("not a spreadsheet").toString("base64"), sheet: "" },
        }),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeError);
        assert.equal(error.statusCode, 503);
        const body = tableParseFailure(error);
        assert.equal(body.error, OPENING_NEEDS_PYTHON);
        assert.equal(body.retry, false);
        assert.equal(body.error.includes("matplotlib"), false);
        assert.equal(/agent runtime/i.test(body.error), false);
        assert.notEqual(body.error, PLOTS_NEED_PYTHON);
        const plot = plotRenderFailure(error);
        assert.notEqual(plot.error, PLOTS_NEED_PYTHON);
        assert.equal(plot.retry, undefined);
        return true;
      },
    );
  } finally {
    setPythonInterpreterForTests(null);
  }
});

test("plot render is 503 when ENSEMBLE_PYTHON has no matplotlib", async () => {
  process.env.ENSEMBLE_INPROCESS_RUNTIME = "1";
  const dir = mkdtempSync(join(tmpdir(), "ensemble-nopy-"));
  const stub = join(dir, "python-no-mpl");
  writeFileSync(
    stub,
    "#!/usr/bin/env python3\nimport sys\nsys.stdout.write('{\"ready\": false, \"missing\": \"matplotlib\"}\\n')\nsys.stdout.flush()\n",
  );
  chmodSync(stub, 0o755);
  const previous = process.env.ENSEMBLE_PYTHON;
  process.env.ENSEMBLE_PYTHON = stub;
  resetPlotWarmupForTests();
  try {
    await assert.rejects(
      () => runtime("/api/plots/run", { method: "POST", json: { code: "import matplotlib", datasets: [] } }),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeError);
        assert.equal(error.statusCode, 503);
        assert.equal(error.message, PLOT_RUNTIME_UNAVAILABLE);
        const body = plotRenderFailure(error);
        assert.equal(body.error, PLOTS_NEED_PYTHON);
        assert.equal(body.retry, false);
        assert.equal(/agent runtime/i.test(body.error), false);
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.ENSEMBLE_PYTHON;
    else process.env.ENSEMBLE_PYTHON = previous;
    resetPlotWarmupForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hosted keeps main's 503 contract and passes a specific runtime message through", () => {
  const previousRuntime = process.env.ENSEMBLE_INPROCESS_RUNTIME;
  const previousDesktop = process.env.ENSEMBLE_DESKTOP;
  delete process.env.ENSEMBLE_INPROCESS_RUNTIME;
  delete process.env.ENSEMBLE_DESKTOP;
  try {
    // The Python runtime cannot be reached: main's sentence and retry, as before #37.
    const down = plotRenderFailure(new RuntimeError("The model runtime is not running. Start it with pnpm dev.", 503, true));
    assert.deepEqual(down, { error: HOSTED_PLOT_RUNTIME_DOWN, retry: true });
    // The runtime answered with its own reason: that reason is the more useful sentence.
    const paused = plotRenderFailure(new RuntimeError("The agent is paused. Resume it from the top bar to allow model calls.", 409));
    assert.deepEqual(paused, { error: "The agent is paused. Resume it from the top bar to allow model calls.", retry: true });
    // Hosted never turns the desktop's missing-Python marker into an install hint.
    const sameWords = plotRenderFailure(new RuntimeError(PLOT_RUNTIME_UNAVAILABLE, 503));
    assert.deepEqual(sameWords, { error: PLOT_RUNTIME_UNAVAILABLE, retry: true });
    const unknown = plotRenderFailure(new Error("socket hang up"));
    assert.deepEqual(unknown, { error: PLOT_RUNTIME_UNAVAILABLE, retry: true });
  } finally {
    if (previousRuntime === undefined) delete process.env.ENSEMBLE_INPROCESS_RUNTIME;
    else process.env.ENSEMBLE_INPROCESS_RUNTIME = previousRuntime;
    if (previousDesktop === undefined) delete process.env.ENSEMBLE_DESKTOP;
    else process.env.ENSEMBLE_DESKTOP = previousDesktop;
  }
});

test("seatbelt grants follow the plot interpreter", () => {
  const python = process.env.PATH?.split(":").map((dir) => join(dir, "python3")).find((candidate) => candidate && existsSync(candidate));
  if (!python) return;
  const paths = pythonReadPaths(python);
  assert.ok(paths.length > 0);
  assert.ok(paths.every((path) => path.startsWith("/")));
});

test("the bundled plot worker matches the agent-runtime source", () => {
  const bundled = fileURLToPath(new URL("./py/plot_worker.py", import.meta.url));
  const live = fileURLToPath(new URL("../../../agent-runtime/ensemble_agent/plots/worker.py", import.meta.url));
  assert.equal(readFileSync(bundled, "utf8"), readFileSync(live, "utf8"));
});

test("the first matplotlib run waits for the font cache, then later runs use 12 seconds", async () => {
  const cache = mkdtempSync(join(tmpdir(), "ensemble-mpl-"));
  const previous = process.env.ENSEMBLE_MPLCONFIGDIR;
  const previousToken = process.env.ENSEMBLE_GIT_TOKEN;
  process.env.ENSEMBLE_MPLCONFIGDIR = cache;
  process.env.ENSEMBLE_GIT_TOKEN = "ghp_plot_worker_must_not_see";
  resetPlotWarmupForTests();
  const timeouts: number[] = [];
  const formats: string[] = [];
  const dpis: number[] = [];
  setPlotRunnerForTests(async (job) => {
    timeouts.push(job.timeoutMs);
    formats.push(job.format);
    dpis.push(job.dpi);
    return { stdout: "", stderr: "" };
  });
  try {
    await runPlot("print(1)", [], "png", 150);
    const again = await runPlot("print(1)", [], "png", 150);
    assert.equal(timeouts[0], FIRST_PLOT_TIMEOUT_MS);
    assert.equal(timeouts[1], PLOT_TIMEOUT_MS);
    assert.equal(matplotlibCacheDir(), cache);
    assert.equal(plotWorkerEnv().MPLCONFIGDIR, cache);
    assert.equal(plotWorkerEnv().ENSEMBLE_GIT_TOKEN, undefined);
    assert.equal(plotWorkerEnv().ENSEMBLE_PLOT_CONCURRENCY, "2");
    assert.deepEqual(formats, ["png", "png"]);
    assert.deepEqual(dpis, [150, 150]);
    assert.equal(again.error, undefined);
  } finally {
    setPlotRunnerForTests(null);
    resetPlotWarmupForTests();
    if (previous === undefined) delete process.env.ENSEMBLE_MPLCONFIGDIR;
    else process.env.ENSEMBLE_MPLCONFIGDIR = previous;
    if (previousToken === undefined) delete process.env.ENSEMBLE_GIT_TOKEN;
    else process.env.ENSEMBLE_GIT_TOKEN = previousToken;
    rmSync(cache, { recursive: true, force: true });
  }
});

test("a timed-out first run stays on the long timeout", async () => {
  resetPlotWarmupForTests();
  setPlotRunnerForTests(async () => ({ timeout: true, stdout: "", stderr: "" }));
  try {
    const first = await runPlot("print(1)", []);
    const second = await runPlot("print(1)", []);
    assert.equal(first.error, "The script ran longer than 45 seconds.");
    assert.equal(second.error, "The script ran longer than 45 seconds.");
  } finally {
    setPlotRunnerForTests(null);
    resetPlotWarmupForTests();
  }
});

test("hosted hub-api marks an unreachable Python runtime as unreachable", async () => {
  const previousRuntime = process.env.ENSEMBLE_INPROCESS_RUNTIME;
  process.env.ENSEMBLE_INPROCESS_RUNTIME = "0";
  const { env } = await import("../config.js");
  const previousUrl = env.AGENT_RUNTIME_URL;
  (env as { AGENT_RUNTIME_URL: string }).AGENT_RUNTIME_URL = "http://127.0.0.1:9";
  try {
    await assert.rejects(
      () => runtime("/api/plots/run", { method: "POST", json: { code: "print(1)", datasets: [] }, timeoutMs: 2_000 }),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeError);
        assert.equal(error.statusCode, 503);
        assert.equal(error.unreachable, true);
        assert.deepEqual(plotRenderFailure(error), { error: HOSTED_PLOT_RUNTIME_DOWN, retry: true });
        return true;
      },
    );
  } finally {
    (env as { AGENT_RUNTIME_URL: string }).AGENT_RUNTIME_URL = previousUrl;
    if (previousRuntime === undefined) delete process.env.ENSEMBLE_INPROCESS_RUNTIME;
    else process.env.ENSEMBLE_INPROCESS_RUNTIME = previousRuntime;
  }
});

const FAKE_WORKER = `
import json, os, sys, time, threading
from collections import deque
lock = threading.Lock()
out = threading.Lock()
def send(obj):
    with out:
        sys.stdout.write(json.dumps(obj) + "\\n")
        sys.stdout.flush()
send({"ready": True, "backend": "Agg", "threads": 1, "fork": False})
cap = max(1, int(os.environ.get("ENSEMBLE_PLOT_CONCURRENCY") or "2"))
queue = deque()
running = {}
cancelled = set()
def run_one(job):
    job_id = str(job["id"])
    send({"id": job_id, "started": True})
    code = str(job.get("code") or "")
    seconds = float(code.split()[1]) if code.startswith("SLEEP ") else 0.0
    timeout = float(job.get("timeout") or 20)
    deadline = time.monotonic() + timeout
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if job_id in cancelled or time.monotonic() >= deadline:
            send({"id": job_id, "timeout": True, "stdout": "", "stderr": ""})
            return
        time.sleep(0.05)
    send({"id": job_id, "timeout": False, "stdout": "OK", "stderr": ""})
def pump():
    while True:
        with lock:
            job = queue.popleft() if queue and len(running) < cap else None
            if job is not None:
                running[str(job["id"])] = True
        if job is None:
            time.sleep(0.02)
            continue
        def work(item=job):
            try:
                run_one(item)
            finally:
                with lock:
                    running.pop(str(item["id"]), None)
        threading.Thread(target=work, daemon=True).start()
threading.Thread(target=pump, daemon=True).start()
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    job = json.loads(line)
    if job.get("cancel"):
        cancelled.add(str(job.get("id")))
        continue
    with lock:
        queue.append(job)
`;

test("queued exports wait, and one timeout does not stop the others", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-fake-worker-"));
  const script = join(dir, "fake_worker.py");
  writeFileSync(script, FAKE_WORKER);
  const previousCap = process.env.ENSEMBLE_PLOT_CONCURRENCY;
  const python = process.env.PATH?.split(":").map((entry) => join(entry, "python3")).find((candidate) => existsSync(candidate));
  assert.ok(python);
  process.env.ENSEMBLE_PLOT_CONCURRENCY = "1";
  setPlotWorkerPathForTests(script);
  resetPlotWorker();
  try {
    const queued = await Promise.all([1, 2, 3].map(() => submitPlot(python, { code: "SLEEP 2", datasets: [], format: "png", dpi: 100, timeout: 3 })));
    assert.deepEqual(queued.map((result) => result.stdout), ["OK", "OK", "OK"]);
    assert.equal(queued.some((result) => result.timeout), false);
    process.env.ENSEMBLE_PLOT_CONCURRENCY = "2";
    resetPlotWorker();
    const [slow, quick] = await Promise.all([
      submitPlot(python, { code: "SLEEP 30", datasets: [], format: "png", dpi: 100, timeout: 3 }),
      submitPlot(python, { code: "SLEEP 2", datasets: [], format: "png", dpi: 100, timeout: 3 }),
    ]);
    assert.equal(quick.stdout, "OK");
    assert.equal(quick.timeout, false);
    assert.equal(slow.timeout, true);
    assert.equal(slow.stdout, "");
    const after = await submitPlot(python, { code: "SLEEP 0.1", datasets: [], format: "png", dpi: 100, timeout: 3 });
    assert.equal(after.stdout, "OK");
    assert.equal(after.timeout, false);
  } finally {
    setPlotWorkerPathForTests(null);
    resetPlotWorker();
    if (previousCap === undefined) delete process.env.ENSEMBLE_PLOT_CONCURRENCY;
    else process.env.ENSEMBLE_PLOT_CONCURRENCY = previousCap;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plot concurrency matches the agent runtime", () => {
  const cases: Array<[string | undefined, number]> = [
    [undefined, 2],
    ["", 2],
    ["   ", 2],
    ["abc", 2],
    ["1.5", 2],
    ["1e2", 2],
    ["0", 1],
    ["-3", 1],
    ["1", 1],
    ["2", 2],
    ["32", 32],
    ["33", 32],
    ["100", 32],
  ];
  const previous = process.env.ENSEMBLE_PLOT_CONCURRENCY;
  try {
    for (const [raw, expected] of cases) {
      assert.equal(parsePlotConcurrency(raw), expected, JSON.stringify(raw));
      if (raw === undefined) delete process.env.ENSEMBLE_PLOT_CONCURRENCY;
      else process.env.ENSEMBLE_PLOT_CONCURRENCY = raw;
      assert.equal(plotConcurrency(), expected, JSON.stringify(raw));
    }
  } finally {
    if (previous === undefined) delete process.env.ENSEMBLE_PLOT_CONCURRENCY;
    else process.env.ENSEMBLE_PLOT_CONCURRENCY = previous;
  }
});

/** Headers go out immediately. The started line waits for a free slot, like the agent. */
function listenPlotQueue(cap: number, holdMs: number): Promise<{ url: string; close: () => Promise<void> }> {
  let running = 0;
  const waiting: ServerResponse[] = [];
  const pump = () => {
    while (running < cap && waiting.length > 0) {
      const res = waiting.shift();
      if (!res) return;
      running += 1;
      res.write(`${JSON.stringify({ started: true })}\n`);
      setTimeout(() => {
        res.end(`${JSON.stringify({ stdout: "OK", stderr: "" })}\n`);
        running -= 1;
        pump();
      }, holdMs);
    }
  };
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    waiting.push(res);
    pump();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("plot queue test server has no port");
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test("cap 1 and four slow exports all succeed", async () => {
  // Each job holds the only slot for 500ms. The fourth starts after 1.5s, which
  // is past the 1.2s run budget. That budget starts at `started`, so it still fits.
  const holdMs = 500;
  const runLimitMs = 1_200;
  const { url, close } = await listenPlotQueue(1, holdMs);
  try {
    const results = await Promise.all(
      [0, 1, 2, 3].map(() => fetchHostedPlotRun({ code: "slow", datasets: [] }, { queueLimitMs: 8_000, runLimitMs }, url)),
    );
    assert.deepEqual(
      results.map((result) => result.stdout),
      ["OK", "OK", "OK", "OK"],
    );
  } finally {
    await close();
  }
});

test("a plot that waits too long says the exports are busy", async () => {
  const previousRuntime = process.env.ENSEMBLE_INPROCESS_RUNTIME;
  const previousDesktop = process.env.ENSEMBLE_DESKTOP;
  process.env.ENSEMBLE_INPROCESS_RUNTIME = "0";
  delete process.env.ENSEMBLE_DESKTOP;
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  });
  const url = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("plot busy test server has no port");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  try {
    await assert.rejects(
      () => fetchHostedPlotRun({ code: "wait", datasets: [] }, { queueLimitMs: 300, runLimitMs: 50_000 }, url),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeError);
        assert.equal(error.unreachable, false);
        assert.equal(error.message, PLOT_EXPORTS_BUSY);
        const body = plotRenderFailure(error);
        assert.equal(body.error, PLOT_EXPORTS_BUSY);
        assert.equal(body.retry, true);
        assert.equal(body.error.includes("not available"), false);
        assert.notEqual(body.error, PLOTS_NEED_PYTHON);
        assert.notEqual(body.error, HOSTED_PLOT_RUNTIME_DOWN);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousRuntime === undefined) delete process.env.ENSEMBLE_INPROCESS_RUNTIME;
    else process.env.ENSEMBLE_INPROCESS_RUNTIME = previousRuntime;
    if (previousDesktop === undefined) delete process.env.ENSEMBLE_DESKTOP;
    else process.env.ENSEMBLE_DESKTOP = previousDesktop;
  }
});

test("the hosted queue cap is under the 120s proxy cut", () => {
  assert.ok(PLOT_QUEUE_LIMIT_MS <= 110_000);
  assert.ok(PLOT_QUEUE_WAIT_CAP_S <= 110);
});

test("a queue wait past the cap is the busy 503 at or before the cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-queue-cap-"));
  const script = join(dir, "fake_worker.py");
  writeFileSync(script, FAKE_WORKER);
  const python = process.env.PATH?.split(":").map((entry) => join(entry, "python3")).find((candidate) => existsSync(candidate));
  assert.ok(python);
  const previousCap = process.env.ENSEMBLE_PLOT_CONCURRENCY;
  process.env.ENSEMBLE_PLOT_CONCURRENCY = "1";
  setPlotWorkerPathForTests(script);
  setPlotQueueSlackForTests(0.05);
  setPlotQueueWaitCapForTests(0.35);
  resetPlotWorker();
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const ahead = (timeout: number) => submitPlot(python, { code: "SLEEP 1", datasets: [], format: "png", dpi: 100, timeout });
  let first: Promise<unknown> = Promise.resolve();
  let second: Promise<unknown> = Promise.resolve();
  try {
    // Each export ahead is 0.2s, so the one behind both is past the 0.35s cap.
    // Those two still fit under the cap themselves and are allowed to run.
    // These may reject while the test awaits something else; settle them in finally.
    first = ahead(0.2);
    first.catch(() => {});
    await sleep(40);
    second = ahead(0.2);
    second.catch(() => {});
    await sleep(40);
    const started = Date.now();
    await assert.rejects(
      () => runPlot("print(1)", []),
      (error: unknown) => {
        assert.ok(error instanceof CallError);
        assert.equal(error.statusCode, 503);
        assert.equal(error.message, PLOT_EXPORTS_BUSY);
        return true;
      },
    );
    const elapsed = Date.now() - started;
    // 0.2 + 0.2 would be the old wait. The waiter stops at the 0.35s cap.
    assert.ok(elapsed < 1_000, `waited ${elapsed}ms`);
  } finally {
    await Promise.allSettled([first, second]);
    setPlotQueueWaitCapForTests(null);
    setPlotQueueSlackForTests(null);
    setPlotWorkerPathForTests(null);
    resetPlotWarmupForTests();
    if (previousCap === undefined) delete process.env.ENSEMBLE_PLOT_CONCURRENCY;
    else process.env.ENSEMBLE_PLOT_CONCURRENCY = previousCap;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queue wait uses each export ahead at its own limit", () => {
  assert.equal(queueStartDelay([], 1), 0);
  assert.equal(queueStartDelay([4.5], 1), 4.5);
  assert.equal(queueStartDelay([4.5, 4.5], 1), 9);
  assert.equal(queueStartDelay([4.5, 4.5], 2), 4.5);
  assert.equal(queueStartDelay([4.5, 4.5, 2], 2), 4.5);
});

test("a queued export behind a first-run limit is not cut off at its own shorter limit", async () => {
  // Production, cap 1: a timeout makes the next export a 45s first run, then a
  // 1.5s export, a 35s export, and a quick one. The quick one's own limit is
  // 12s, so the old wait was 17s and it died about 18s early. These numbers
  // are that timeline at 1/10, including the 5s slack.
  const dir = mkdtempSync(join(tmpdir(), "ensemble-queue-limit-"));
  const script = join(dir, "fake_worker.py");
  writeFileSync(script, FAKE_WORKER);
  const python = process.env.PATH?.split(":").map((entry) => join(entry, "python3")).find((candidate) => existsSync(candidate));
  assert.ok(python);
  const previousCap = process.env.ENSEMBLE_PLOT_CONCURRENCY;
  process.env.ENSEMBLE_PLOT_CONCURRENCY = "1";
  setPlotWorkerPathForTests(script);
  setPlotQueueSlackForTests(0.5);
  resetPlotWorker();
  const job = (code: string, timeout: number) => submitPlot(python, { code, datasets: [], format: "png", dpi: 100, timeout });
  try {
    const forced = await job("SLEEP 30", 0.4);
    assert.equal(forced.timeout, true);
    const short = job("SLEEP 0.15", 4.5);
    const long = job("SLEEP 3.5", 4.5);
    const finishedShort = await short;
    assert.equal(finishedShort.stdout, "OK");
    assert.equal(finishedShort.timeout, false);
    const started = Date.now();
    const quick = await job("SLEEP 0.05", 1.2);
    const elapsed = Date.now() - started;
    const longResult = await long;
    assert.equal(longResult.stdout, "OK");
    assert.equal(longResult.timeout, false);
    assert.equal(quick.timeout, false);
    assert.equal(quick.stdout, "OK");
    assert.equal(quick.error, undefined);
    // The old waiter gave up at 1.2s + 0.5s. The 3.5s export was still inside its 4.5s limit.
    assert.ok(elapsed > 3_000, `cut off early after ${elapsed}ms`);
  } finally {
    setPlotQueueSlackForTests(null);
    setPlotWorkerPathForTests(null);
    resetPlotWorker();
    if (previousCap === undefined) delete process.env.ENSEMBLE_PLOT_CONCURRENCY;
    else process.env.ENSEMBLE_PLOT_CONCURRENCY = previousCap;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("giving up before an export starts is the busy 503, not a figure error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-never-start-"));
  const script = join(dir, "hang.py");
  writeFileSync(
    script,
    "import json, sys\nsys.stdout.write(json.dumps({\"ready\": True, \"backend\": \"Agg\", \"threads\": 1, \"fork\": False}) + \"\\n\")\nsys.stdout.flush()\nfor line in sys.stdin:\n    pass\n",
  );
  const previousCap = process.env.ENSEMBLE_PLOT_CONCURRENCY;
  process.env.ENSEMBLE_PLOT_CONCURRENCY = "1";
  setPlotWorkerPathForTests(script);
  setPlotQueueSlackForTests(0.3);
  resetPlotWarmupForTests();
  try {
    await assert.rejects(
      () => runPlot("print(1)", []),
      (error: unknown) => {
        assert.ok(error instanceof CallError);
        assert.equal(error.statusCode, 503);
        assert.equal(error.message, PLOT_EXPORTS_BUSY);
        assert.equal(error.message.includes("could not draw"), false);
        assert.equal(error.message.includes("did not start"), false);
        assert.notEqual(error.message, PLOT_RUNTIME_UNAVAILABLE);
        assert.notEqual(error.message, PLOTS_NEED_PYTHON);
        return true;
      },
    );
    assert.deepEqual(plotExportErrorReply(PLOT_EXPORTS_BUSY), { statusCode: 503, error: PLOT_EXPORTS_BUSY, retry: true });
    assert.deepEqual(plotExportErrorReply("The script finished without a figure."), { statusCode: 400, error: "The script finished without a figure." });
    assert.equal(PLOTS_NEED_PYTHON, "Plots need Python 3 with matplotlib on this computer. Install it, then try again.");
  } finally {
    setPlotQueueSlackForTests(null);
    setPlotWorkerPathForTests(null);
    resetPlotWarmupForTests();
    if (previousCap === undefined) delete process.env.ENSEMBLE_PLOT_CONCURRENCY;
    else process.env.ENSEMBLE_PLOT_CONCURRENCY = previousCap;
    rmSync(dir, { recursive: true, force: true });
  }
});
