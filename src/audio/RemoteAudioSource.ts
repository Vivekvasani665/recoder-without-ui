import { RecorderError } from "../utils/errors";
import type { AudioSource } from "./AudioSource";

/**
 * The CLIENT's voice from a stream your application already has, e.g. the
 * remote MediaStream of a WebRTC call. This is the most reliable way to get
 * the client's voice cleanly, because it never touches your microphone.
 *
 * The recorder does not own these tracks, so stop() leaves them running.
 *
 * Chromium note: a remote WebRTC stream may need to be attached to a (muted)
 * <audio> element elsewhere in your app before Web Audio receives samples.
 */
export class RemoteAudioSource implements AudioSource {
  readonly kind = "remote" as const;

  constructor(private readonly streams: MediaStream[]) {}

  async start(): Promise<MediaStream> {
    const tracks = this.streams.flatMap((s) => s.getAudioTracks()).filter((t) => t.readyState !== "ended");
    if (tracks.length === 0) {
      throw new RecorderError("REMOTE_AUDIO_UNAVAILABLE", "remoteAudio contains no live audio track.", "remote-audio");
    }
    return new MediaStream(tracks);
  }

  stop(): void {
    // Caller-owned tracks: intentionally not stopped.
  }
}
