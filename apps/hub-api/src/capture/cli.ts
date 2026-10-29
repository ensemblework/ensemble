/**
 * The capture commands' entry in the local runtime, run by the CLI with the sidecar's Node:
 * `node --import tsx src/capture/cli.ts status|setup [--json] [--dry-run]`. Progress goes to
 * stderr; the report (JSON with --json) to stdout. It needs no database.
 */
import { captureCapabilities, type CaptureCapabilities } from "./capabilities.js";
import { captureSetup } from "./setup.js";

function lines(caps: CaptureCapabilities): string[] {
  const out = [`browser: ${caps.browser.available ? `${caps.browser.kind} r${caps.browser.revision ?? "?"} (${caps.browser.source})` : "none"}`];
  out.push(`video: ${caps.video ? `${caps.video.container.toUpperCase()} (${caps.video.codec})` : "none"}`);
  if (caps.platform === "linux") out.push(`virtual display: ${caps.virtualDisplay.xvfb ? `Xvfb${caps.virtualDisplay.windowManager ? ` + ${caps.virtualDisplay.windowManager}` : ""}` : "none"}`);
  for (const [target, value] of Object.entries(caps.targets)) out.push(`${target.padEnd(9)} screenshots ${value.screenshot ? "yes" : "no "}  video ${value.video ? "yes" : "no "}${value.reason ? `  ${value.reason}` : ""}`);
  for (const note of caps.setup.notes) out.push(`note: ${note}`);
  if (caps.setup.ensembleInstalls.length) out.push(`ensemble capture setup installs: ${caps.setup.ensembleInstalls.join(", ")}`);
  if (caps.setup.systemCommand) out.push(`system packages: ${caps.setup.systemCommand}`);
  return out;
}

async function main(argv: string[]): Promise<void> {
  const command = argv.find((arg) => !arg.startsWith("-")) ?? "status";
  const json = argv.includes("--json");
  if (command === "status") {
    const caps = await captureCapabilities({ refresh: true });
    process.stdout.write(json ? `${JSON.stringify(caps)}\n` : `${lines(caps).join("\n")}\n`);
    return;
  }
  if (command === "setup") {
    const result = await captureSetup({ dryRun: argv.includes("--dry-run"), onOutput: (line) => process.stderr.write(`${line}\n`) });
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write(`${[...result.steps.map((step) => `${step.ok ? "ok" : "failed"}: ${step.name}. ${step.detail}`), ...lines(result.after)].join("\n")}\n`);
    if (!result.steps.every((step) => step.ok)) process.exitCode = 1;
    return;
  }
  process.stderr.write("usage: capture/cli.ts status|setup [--json] [--dry-run]\n");
  process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
