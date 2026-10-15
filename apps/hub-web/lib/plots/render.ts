/**
 * Rendering a plot's Python, wherever it can run (docs/02 Plots). This server runs it for its operator
 * and on this computer; on Ensemble on the web, where it would refuse (`HOST_ACCESS_DENIED`), the same
 * script runs in this browser (`browser-python.ts`) with the same datasets and helper module, and the
 * result has the same shape.
 */
import { ApiError, api } from "@/lib/api";
import { runPlotInBrowser } from "./browser-python";

type Format = "png" | "svg" | "pdf" | "eps";
export type RenderResult = { format: string; data: string; stdout: string; stderr: string };

let serverPython: boolean | null = null;

/** Learned once per tab: whether the server runs plot Python for this account. */
export async function plotsRunOnServer(): Promise<boolean> {
  if (serverPython !== null) return serverPython;
  try {
    serverPython = (await api.plotRuntime()).serverPython;
  } catch {
    // An older server without the route runs plots itself.
    serverPython = true;
  }
  return serverPython;
}

export function forgetPlotRuntime(): void {
  serverPython = null;
}

/** A plot script's failure, with the line it failed on, like the server's 400. */
export class PlotScriptError extends ApiError {
  constructor(
    message: string,
    readonly line: number | null,
    readonly stderr: string,
  ) {
    super(message, 400);
  }
}

export async function renderPlot(id: string, body: { format: Format; code?: string; dpi?: number; accent?: string }, runner = runPlotInBrowser): Promise<RenderResult> {
  if (await plotsRunOnServer()) {
    try {
      return await api.renderPlotOnServer(id, { format: body.format, code: body.code, dpi: body.dpi });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 403 && error.code === "HOST_ACCESS_DENIED")) throw error;
      serverPython = false;
    }
  }
  const input = await api.plotRenderInput(id, body.accent);
  const result = await runner({ code: body.code ?? input.code, datasets: input.datasets, format: body.format, dpi: body.dpi });
  if (result.error) throw new PlotScriptError(result.line ? `Line ${result.line}: ${result.error}` : result.error, result.line, result.stderr);
  if (!result.data) throw new PlotScriptError("The script finished without a figure. Call save() or plt.show().", null, result.stderr);
  return { format: result.format, data: result.data, stdout: result.stdout, stderr: result.stderr };
}

/** The script line a failed run names ("Line 12: NameError: …"), from this browser or the server. */
export function scriptErrorLine(message: string): number | null {
  const match = /^Line (\d+):/.exec(message);
  return match ? Number(match[1]) : null;
}
