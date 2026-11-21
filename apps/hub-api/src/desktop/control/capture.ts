/**
 * The capture tools' `desktop` target (capture/service.ts `DesktopCapture`): a screenshot or a
 * recording of the owner's real screen into the work's evidence folder, through the desktop service.
 * It needs no controller (it sends no input) but waits while the owner has the computer, and what it
 * makes is always held for the owner's preview.
 */
import { CaptureError, type MediaFile } from "../../capture/media.js";
import type { DesktopCapture } from "../../capture/service.js";
import { desktopService } from "./index.js";
import { DesktopError } from "./service.js";

function captureError(error: unknown): unknown {
  if (!(error instanceof DesktopError)) return error;
  const code = error.code === "unsupported" ? "not_supported" : error.code === "consent_needed" || error.code === "unavailable" ? "unavailable" : error.code === "owner_has_control" || error.code === "screen_locked" || error.code === "refused" ? "refused" : error.code === "bad_input" ? "bad_input" : "failed";
  return new CaptureError(code, error.message);
}

export function desktopCapture(): DesktopCapture | null {
  if (process.platform !== "linux") return null;
  return {
    async screenshot(evidenceDir: string, name?: string): Promise<MediaFile> {
      try {
        const shot = await desktopService().evidenceScreenshot({ evidenceDir, name: name ?? "screen" });
        return { path: shot.path, kind: "image", mime: shot.mime, size: shot.size, width: shot.width, height: shot.height, held: true, reason: shot.reason };
      } catch (error) {
        throw captureError(error);
      }
    },
    async video(evidenceDir: string, seconds: number, name?: string): Promise<MediaFile> {
      try {
        const saved = await desktopService().evidenceVideo({ evidenceDir, seconds, name });
        const { sha256: _sha256, ...file } = saved;
        return file;
      } catch (error) {
        throw captureError(error);
      }
    },
  };
}
