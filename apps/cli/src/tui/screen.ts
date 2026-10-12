/** How the app takes over the terminal: the alternate screen, no line wrapping, and Ink's render options. */
import type { EventEmitter } from "node:events";

const ALT_ON = "\u001B[?1049h\u001B[H";
const ALT_OFF = "\u001B[?1049l";
const WRAP_OFF = "\u001B[?7l";
const WRAP_ON = "\u001B[?7h";
const CLEAR = "\u001B[2J\u001B[H";

// Not incrementalRendering: in Ink 6.8 it lands one row low whenever the frame is shorter than
// the terminal (ours leaves the last row free), so every update scrolled the tabs off the top.
export const RENDER_OPTIONS = { exitOnCtrlC: false, patchConsole: true, maxFps: 30 } as const;

type Terminal = EventEmitter & { columns?: number; rows?: number; write(data: string): boolean };

/**
 * Switches to the alternate screen with line wrapping off, and clears it when the terminal's
 * size changes. Call before Ink's render, so the clear runs before Ink redraws: Ink first redraws
 * the old, wider frame, and wrapped lines would scroll the top of the app away. Returns the undo.
 */
export function takeScreen(terminal: Terminal): () => void {
  let size = `${terminal.columns}x${terminal.rows}`;
  const resized = () => {
    const next = `${terminal.columns}x${terminal.rows}`;
    if (next === size) return;
    size = next;
    terminal.write(CLEAR);
  };
  terminal.write(ALT_ON + WRAP_OFF);
  terminal.on("resize", resized);
  return () => {
    terminal.off("resize", resized);
    terminal.write(WRAP_ON + ALT_OFF);
  };
}
