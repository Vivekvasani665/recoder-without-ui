import { RecorderError } from "../utils/errors";
import type { AudioSource } from "./AudioSource";

/**
 * System / tab audio delivered with the screen share — typically the CLIENT's
 * voice as played by a call app (Meet, Zoom web, Teams web, ...).
 *
 * Availability depends on browser + OS + what the user ticks in the picker:
 * Chromium on Windows/ChromeOS can share full system audio; macOS only on
 * recent Chromium with macOS 14.2+; Firefox and Safari do not share system
 * audio. When it is missing, start() throws SYSTEM_AUDIO_UNAVAILABLE.
 */
export class SystemAudioSource implements AudioSource {
  readonly kind = "system" as const;
  private track: MediaStreamTrack | null = null;

  constructor(private readonly displayStream: MediaStream) {}

  async start(): Promise<MediaStream> {
    this.track = this.displayStream.getAudioTracks()[0] ?? null;
    if (!this.track) {
      throw new RecorderError(
        "SYSTEM_AUDIO_UNAVAILABLE",
        "No system audio was shared. The user must tick 'Share system audio' / 'Share tab audio' in the picker, and the browser/OS must support it.",
        "system-audio",
      );
    }
    return new MediaStream([this.track]);
  }

  stop(): void {
    this.track?.stop();
    this.track = null;
  }
}
