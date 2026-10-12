/** How the app takes over the terminal: the alternate screen, and Ink's render options. */
export const ALT_ON = "\u001B[?1049h\u001B[H";
export const ALT_OFF = "\u001B[?1049l";

// Not incrementalRendering: in Ink 6.8 it lands one row low whenever the frame is shorter than
// the terminal (ours leaves the last row free), so every update scrolled the tabs off the top.
export const RENDER_OPTIONS = { exitOnCtrlC: false, patchConsole: true, maxFps: 30 } as const;
