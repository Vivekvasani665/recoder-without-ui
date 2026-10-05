import { RecorderError, fromMediaError } from "../utils/errors";
import type { DisplaySurface, ScreenCaptureOptions } from "./CaptureTypes";

/**
 * Full-screen capture with the browser-native Screen Capture API.
 *
 * The only visible UI is the browser's own share picker. It cannot be
 * bypassed or pre-approved by script: that is a browser security guarantee.
 */
export class ScreenCapture {
  private stream: MediaStream | null = null;
  private onEnded: (() => void) | null = null;

  async start(options: ScreenCaptureOptions, onEnded: () => void): Promise<MediaStream> {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getDisplayMedia !== "function") {
      throw new RecorderError(
        "UNSUPPORTED_BROWSER",
        "navigator.mediaDevices.getDisplayMedia is not available. Use a desktop Chromium, Firefox or Safari over HTTPS.",
        "browser",
      );
    }

    const video: MediaTrackConstraints & { displaySurface?: string } = {
      frameRate: { ideal: options.frameRate, max: options.frameRate },
      displaySurface: "monitor", // preselect "Entire screen" where supported
    };
    if (options.width) video.width = { ideal: options.width };
    if (options.height) video.height = { ideal: options.height };

    const constraints: DisplayMediaStreamOptions & Record<string, unknown> = {
      video,
      // Raw system audio: browser DSP here would degrade the client's voice.
      audio: options.systemAudio
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : false,
      // Chromium hints; ignored elsewhere.
      monitorTypeSurfaces: "include",
      systemAudio: options.systemAudio ? "include" : "exclude",
      selfBrowserSurface: "exclude",
      surfaceSwitching: "exclude",
    };

    try {
      this.stream = await md.getDisplayMedia(constraints);
    } catch (err) {
      throw fromMediaError(err, "screen");
    }

    const track = this.stream.getVideoTracks()[0];
    if (!track) {
      this.stop();
      throw new RecorderError("DEVICE_NOT_FOUND", "Screen capture returned no video track.", "screen");
    }

    // Browser's native "Stop sharing" → let the recorder finalize.
    this.onEnded = onEnded;
    track.addEventListener("ended", this.onEnded);
    return this.stream;
  }

  get videoTrack(): MediaStreamTrack | null {
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  /** The shared stream (system/tab audio is read from here by SystemAudioSource). */
  get displayStream(): MediaStream | null {
    return this.stream;
  }

  /** What the user actually picked. Script cannot force "Entire screen". */
  get surface(): DisplaySurface {
    const s = (this.videoTrack?.getSettings() as { displaySurface?: string } | undefined)?.displaySurface;
    return s === "monitor" || s === "window" || s === "browser" ? s : "unknown";
  }

  stop(): void {
    const track = this.videoTrack;
    if (track && this.onEnded) track.removeEventListener("ended", this.onEnded);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.onEnded = null;
  }
}
