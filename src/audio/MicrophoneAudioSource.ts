import type { MicrophoneOptions } from "../api/types";
import { RecorderError, fromMediaError } from "../utils/errors";
import type { AudioSource } from "./AudioSource";

/**
 * YOUR voice: the local microphone, captured as its own stream.
 *
 * echoCancellation / noiseSuppression / autoGainControl default to false.
 * They are ordinary noise processors that are built to keep all speech,
 * so they are not a way to remove other people's voices.
 */
export class MicrophoneAudioSource implements AudioSource {
  readonly kind = "microphone" as const;
  private stream: MediaStream | null = null;

  constructor(private readonly options: MicrophoneOptions = {}) {}

  async start(): Promise<MediaStream> {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getUserMedia !== "function") {
      throw new RecorderError("UNSUPPORTED_BROWSER", "navigator.mediaDevices.getUserMedia is not available.", "browser");
    }

    const audio: MediaTrackConstraints = {
      echoCancellation: this.options.echoCancellation ?? false,
      noiseSuppression: this.options.noiseSuppression ?? false,
      autoGainControl: this.options.autoGainControl ?? false,
      channelCount: { ideal: 1 },
    };
    if (this.options.deviceId) audio.deviceId = { exact: this.options.deviceId };

    try {
      this.stream = await md.getUserMedia({ audio, video: false });
    } catch (err) {
      throw fromMediaError(err, "microphone");
    }
    if (this.stream.getAudioTracks().length === 0) {
      this.stop();
      throw new RecorderError("DEVICE_NOT_FOUND", "The microphone stream has no audio track.", "microphone");
    }
    return this.stream;
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
