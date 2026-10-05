import { RecorderError } from "../utils/errors";
import { getSupportedMimeType, isMimeTypeSupported } from "../utils/mime";

export interface MediaRecorderControllerOptions {
  mimeType?: string;
  videoBitsPerSecond?: number;
  audioBitsPerSecond?: number;
  timeslice: number;
  onData(chunk: Blob, totalChunks: number, totalSize: number): void;
  onError(error: RecorderError): void;
}

/** Resolves the MIME type to use, or throws for an explicitly requested unsupported one. */
export function resolveMimeType(preferred?: string): string {
  if (preferred) {
    if (!isMimeTypeSupported(preferred)) {
      throw new RecorderError("MIME_TYPE_UNSUPPORTED", `MIME type "${preferred}" is not supported by this browser's MediaRecorder.`, "recorder");
    }
    return preferred;
  }
  return getSupportedMimeType();
}

/**
 * Wraps MediaRecorder: owns the chunks and turns stop into a Promise<Blob>.
 */
export class MediaRecorderController {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private totalSize = 0;
  private stopping: Promise<Blob> | null = null;
  mimeType = "";

  static isSupported(): boolean {
    return typeof MediaRecorder === "function";
  }

  start(stream: MediaStream, options: MediaRecorderControllerOptions): void {
    if (!MediaRecorderController.isSupported()) {
      throw new RecorderError("MEDIARECORDER_UNSUPPORTED", "MediaRecorder is not available in this browser.", "browser");
    }
    const mimeType = resolveMimeType(options.mimeType);
    this.chunks = [];
    this.totalSize = 0;
    this.stopping = null;

    try {
      this.recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        ...(options.videoBitsPerSecond ? { videoBitsPerSecond: options.videoBitsPerSecond } : {}),
        ...(options.audioBitsPerSecond && stream.getAudioTracks().length ? { audioBitsPerSecond: options.audioBitsPerSecond } : {}),
      });
    } catch (err) {
      throw new RecorderError("RECORDER_FAILED", `MediaRecorder could not be created: ${String(err)}`, "recorder", err);
    }
    this.mimeType = this.recorder.mimeType || mimeType || "video/webm";

    this.recorder.ondataavailable = (e: BlobEvent) => {
      if (!e.data || e.data.size === 0) return;
      this.chunks.push(e.data);
      this.totalSize += e.data.size;
      options.onData(e.data, this.chunks.length, this.totalSize);
    };
    this.recorder.onerror = (e: Event) => {
      const cause = (e as Event & { error?: unknown }).error ?? e;
      options.onError(new RecorderError("RECORDER_FAILED", `MediaRecorder error: ${String(cause)}`, "recorder", cause));
    };

    try {
      this.recorder.start(options.timeslice);
    } catch (err) {
      throw new RecorderError("RECORDER_FAILED", `MediaRecorder failed to start: ${String(err)}`, "recorder", err);
    }
  }

  pause(): void {
    if (this.recorder?.state === "recording") this.recorder.pause();
  }

  resume(): void {
    if (this.recorder?.state === "paused") this.recorder.resume();
  }

  /**
   * Stops recording synchronously (MediaRecorder.stop()) and resolves with
   * the final Blob after the last chunk is flushed.
   */
  stop(): Promise<Blob> {
    if (this.stopping) return this.stopping;
    const recorder = this.recorder;
    if (!recorder || recorder.state === "inactive") {
      this.stopping = Promise.resolve(this.buildBlob());
      return this.stopping;
    }
    this.stopping = new Promise<Blob>((resolve) => {
      recorder.addEventListener("stop", () => resolve(this.buildBlob()), { once: true });
    });
    recorder.stop();
    return this.stopping;
  }

  private buildBlob(): Blob {
    return new Blob(this.chunks, { type: this.mimeType || "video/webm" });
  }

  release(): void {
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onerror = null;
      if (this.recorder.state !== "inactive") {
        try {
          this.recorder.stop();
        } catch {
          /* ignore */
        }
      }
    }
    this.recorder = null;
    this.chunks = [];
    this.totalSize = 0;
    this.stopping = null;
  }
}
