import type {
  RecordingResult,
  RecordingSession,
  RecordingStatus,
  StartRecordingOptions,
  StopReason,
} from "../api/types";
import type { AudioSourceKind } from "../audio/AudioSource";
import { RecorderEvents, type RecorderEventHandler, type RecorderEventName } from "../events/RecorderEvents";
import { RecorderError } from "../utils/errors";
import { MediaRecorderController, resolveMimeType } from "./MediaRecorderController";
import { RecorderSession } from "./RecorderSession";

const DEFAULTS = {
  frameRate: 30,
  videoBitsPerSecond: 5_000_000,
  audioBitsPerSecond: 128_000,
  timeslice: 1000,
};

/**
 * Headless recorder. The whole lifecycle is driven by method calls:
 *
 *   start → recording ⇄ paused → stopping → stopped
 *
 * There is no UI; the browser's native screen picker is the only thing the
 * user sees.
 */
export class Recorder {
  /** Pass a shared emitter so other modules (e.g. Drive) publish on the same bus. */
  constructor(private readonly events: RecorderEvents = new RecorderEvents()) {}

  private session: RecorderSession | null = null;
  private finalizing: Promise<RecordingResult> | null = null;
  private lastResult: RecordingResult | null = null;

  // ─── Events ──────────────────────────────────────────────────────────────

  on = <K extends RecorderEventName>(event: K, handler: RecorderEventHandler<K>): (() => void) =>
    this.events.on(event, handler);

  once = <K extends RecorderEventName>(event: K, handler: RecorderEventHandler<K>): (() => void) =>
    this.events.once(event, handler);

  off = <K extends RecorderEventName>(event: K, handler: RecorderEventHandler<K>): void =>
    this.events.off(event, handler);

  // ─── Commands ────────────────────────────────────────────────────────────

  /**
   * Requests the screen (browser-native picker), builds the audio pipeline,
   * starts MediaRecorder and the internal timer. Rejects with a RecorderError.
   */
  async startRecording(options: StartRecordingOptions = {}): Promise<RecordingSession> {
    const current = this.session?.state;
    if (current === "starting" || current === "recording" || current === "paused" || current === "stopping") {
      throw this.raise(new RecorderError("ALREADY_RECORDING", `A recording is already ${current}.`, "state"));
    }
    this.preflight(options);

    const session = new RecorderSession();
    session.requestedDuration = options.duration ?? null;
    this.session = session;
    this.lastResult = null;

    // Must run before the first await: unlocks audio while the click is still active.
    if (options.microphone !== false || options.systemAudio !== false || options.remoteAudio) {
      try {
        session.audio.prepare();
      } catch (err) {
        session.state = "error";
        throw this.raise(err);
      }
    }

    try {
      // 1–2. Screen + video.
      const display = await session.screen.start(
        {
          frameRate: options.video?.frameRate ?? DEFAULTS.frameRate,
          width: options.video?.width,
          height: options.video?.height,
          systemAudio: (options.systemAudio ?? true) !== false,
        },
        () => this.handleScreenEnded(session),
      );
      if (session.screen.surface !== "monitor" && session.screen.surface !== "unknown") {
        session.warnings.push(`A ${session.screen.surface} was shared instead of the entire screen.`);
      }

      // 3. Audio pipeline (sources → isolation → mixer).
      const audio = await session.audio.start(display, options);
      session.audioStatus = audio.status;
      session.warnings.push(...audio.warnings);

      if (session.screenEndedDuringStart) {
        throw new RecorderError("SCREEN_SHARE_ENDED", "Screen sharing was stopped before recording began.", "screen");
      }

      // Optional webcam bubble: composite screen + camera into one video track.
      const videoTrack = await this.prepareVideo(session, display.getVideoTracks()[0], options);

      if (session.screenEndedDuringStart) {
        throw new RecorderError("SCREEN_SHARE_ENDED", "Screen sharing was stopped before recording began.", "screen");
      }

      // 4–5. MediaRecorder on (composited) video + final audio.
      const tracks = [videoTrack, ...(audio.track ? [audio.track] : [])];
      session.mediaRecorder.start(new MediaStream(tracks), {
        mimeType: options.mimeType,
        videoBitsPerSecond: options.video?.bitsPerSecond ?? DEFAULTS.videoBitsPerSecond,
        audioBitsPerSecond: options.audioBitsPerSecond ?? DEFAULTS.audioBitsPerSecond,
        timeslice: options.timeslice ?? DEFAULTS.timeslice,
        onData: (chunk, totalChunks, totalSize) =>
          this.events.emit("recording:data", { id: session.id, chunk, size: chunk.size, totalChunks, totalSize }),
        onError: (error) => {
          this.raise(error);
          void this.finalize(session, "error").catch(() => undefined);
        },
      });

      // 6. Internal timer (+ optional auto-stop).
      session.state = "recording";
      session.startedAt = new Date();
      session.timer.start(options.duration, () => {
        void this.finalize(session, "duration").catch(() => undefined); // already emitted
      });

      // 7.
      const result = this.toSession(session);
      this.events.emit("recording:start", result);
      return result;
    } catch (err) {
      await session.release();
      session.state = "error";
      throw this.raise(err);
    }
  }

  /**
   * Stops immediately and resolves with the Blob + metadata.
   * Concurrent calls share one result; calling again after a recording has
   * ended (manually, by `duration` or by "Stop sharing") returns that result.
   */
  stopRecording(): Promise<RecordingResult> {
    const session = this.session;
    if (session && (session.state === "recording" || session.state === "paused" || session.state === "stopping")) {
      return this.finalize(session, "manual");
    }
    if (session?.state === "stopped" && this.lastResult?.id === session.id) {
      return Promise.resolve(this.lastResult);
    }
    const why = session?.state === "starting" ? "Recording is still starting." : "No recording is in progress.";
    return Promise.reject(this.raise(new RecorderError("NOT_RECORDING", why, "state")));
  }

  pauseRecording(): void {
    const session = this.session;
    if (!session || session.state !== "recording") {
      throw this.raise(new RecorderError("INVALID_STATE", `Cannot pause while ${session?.state ?? "idle"}.`, "state"));
    }
    session.mediaRecorder.pause();
    session.timer.pause();
    session.state = "paused";
    this.events.emit("recording:pause", this.getRecordingStatus());
  }

  resumeRecording(): void {
    const session = this.session;
    if (!session || session.state !== "paused") {
      throw this.raise(new RecorderError("INVALID_STATE", `Cannot resume while ${session?.state ?? "idle"}.`, "state"));
    }
    session.mediaRecorder.resume();
    session.timer.resume();
    session.state = "recording";
    this.events.emit("recording:resume", this.getRecordingStatus());
  }

  // ─── Queries ─────────────────────────────────────────────────────────────

  getRecordingStatus(): RecordingStatus {
    const s = this.session;
    if (!s) {
      return {
        id: null,
        status: "idle",
        elapsedSeconds: 0,
        elapsedMs: 0,
        durationSeconds: null,
        startedAt: null,
        stoppedAt: null,
        stopReason: null,
        mimeType: null,
        audio: null,
        camera: null,
        warnings: [],
      };
    }
    const elapsedMs = s.durationMs ?? s.timer.elapsedMs;
    return {
      id: s.id,
      status: s.state,
      elapsedSeconds: Math.floor(elapsedMs / 1000),
      elapsedMs,
      durationSeconds: s.durationMs === null ? null : Math.round(s.durationMs / 1000),
      startedAt: s.startedAt?.toISOString() ?? null,
      stoppedAt: s.stoppedAt?.toISOString() ?? null,
      stopReason: s.stopReason,
      mimeType: s.mediaRecorder.mimeType || null,
      audio: { ...s.audioStatus },
      camera: s.cameraStatus,
      warnings: [...s.warnings],
    };
  }

  /** True while a recording is active (recording or paused). */
  isRecording(): boolean {
    return this.session?.state === "recording" || this.session?.state === "paused";
  }

  /** Whole seconds recorded (pauses excluded). Final value after stop; 0 when idle. */
  getRecordingDuration(): number {
    return this.getRecordingStatus().elapsedSeconds;
  }

  /** Live input level per audio source (0..1) — use it to confirm audio is arriving. */
  getAudioLevels(): Partial<Record<AudioSourceKind, number>> {
    return this.isRecording() ? (this.session?.audio.getLevels() ?? {}) : {};
  }

  /** Live per-source mix level while recording. */
  setGain(kind: AudioSourceKind, value: number): void {
    this.session?.audio.setGain(kind, value);
  }

  /** Stops any active recording and removes all listeners. */
  async destroy(): Promise<void> {
    if (this.isRecording()) await this.stopRecording().catch(() => undefined);
    await this.session?.release();
    this.session = null;
    this.lastResult = null;
    this.events.removeAll();
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private preflight(options: StartRecordingOptions): void {
    if ((globalThis as { isSecureContext?: boolean }).isSecureContext === false) {
      throw this.raise(new RecorderError("INSECURE_CONTEXT", "Screen recording requires HTTPS or localhost.", "browser"));
    }
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getDisplayMedia !== "function") {
      throw this.raise(
        new RecorderError("UNSUPPORTED_BROWSER", "Screen capture (getDisplayMedia) is not supported in this browser.", "browser"),
      );
    }
    if (!MediaRecorderController.isSupported()) {
      throw this.raise(new RecorderError("MEDIARECORDER_UNSUPPORTED", "MediaRecorder is not supported in this browser.", "browser"));
    }
    if (options.duration !== undefined && !(Number.isFinite(options.duration) && options.duration > 0)) {
      throw this.raise(new RecorderError("INVALID_OPTIONS", "`duration` must be a positive number of milliseconds.", "state"));
    }
    // Fail on an explicitly requested unsupported MIME type before prompting the user.
    try {
      resolveMimeType(options.mimeType);
    } catch (err) {
      throw this.raise(err);
    }
  }

  private async prepareVideo(
    session: RecorderSession,
    screenTrack: MediaStreamTrack,
    options: StartRecordingOptions,
  ): Promise<MediaStreamTrack> {
    if (!options.camera) return screenTrack;
    const cameraOptions = options.camera === true ? {} : options.camera;
    try {
      const cameraStream = await session.camera.start(cameraOptions);
      const track = await session.compositor.start(
        screenTrack,
        cameraStream,
        options.video?.frameRate ?? DEFAULTS.frameRate,
        cameraOptions,
      );
      session.cameraStatus = "active";
      return track;
    } catch (err) {
      session.compositor.stop();
      session.camera.stop();
      if (cameraOptions.required) throw err;
      session.cameraStatus = "unavailable";
      session.warnings.push(`Recording without camera: ${(err as Error).message}`);
      return screenTrack;
    }
  }

  private handleScreenEnded(session: RecorderSession): void {
    if (session !== this.session) return;
    if (session.state === "starting") {
      session.screenEndedDuringStart = true;
      return;
    }
    if (session.state === "recording" || session.state === "paused") {
      this.events.emit("recording:screen-ended", this.getRecordingStatus());
      void this.finalize(session, "screen-ended").catch(() => undefined); // already emitted
    }
  }

  private finalize(session: RecorderSession, reason: StopReason): Promise<RecordingResult> {
    if (this.finalizing && session.state === "stopping") return this.finalizing;

    session.state = "stopping";
    session.stopReason = reason;

    this.finalizing = (async (): Promise<RecordingResult> => {
      try {
        // 1. Stop MediaRecorder now (final chunk is flushed asynchronously).
        const blobPromise = session.mediaRecorder.stop();
        // 2–5. Stop timer, release screen, microphone, AudioContext.
        session.durationMs = session.timer.stop();
        session.compositor.stop();
        session.camera.stop();
        session.screen.stop();
        await session.audio.stop();
        // 6. Final Blob.
        const blob = await blobPromise;
        session.mediaRecorder.release();

        session.stoppedAt = new Date();
        session.state = "stopped";
        const result: RecordingResult = {
          id: session.id,
          status: "stopped",
          stopReason: reason,
          recording: {
            durationSeconds: Math.round(session.durationMs / 1000),
            mimeType: blob.type,
            size: blob.size,
          },
          durationSeconds: Math.round(session.durationMs / 1000),
          durationMs: session.durationMs,
          mimeType: blob.type,
          size: blob.size,
          blob,
          startedAt: (session.startedAt ?? session.stoppedAt).toISOString(),
          stoppedAt: session.stoppedAt.toISOString(),
          audio: { ...session.audioStatus },
          camera: session.cameraStatus,
          warnings: [...session.warnings],
        };
        this.lastResult = result;
        // 7.
        this.events.emit("recording:stop", result);
        return result;
      } catch (err) {
        await session.release();
        session.state = "error";
        throw this.raise(
          err instanceof RecorderError
            ? err
            : new RecorderError("RECORDER_FAILED", `Failed to finalize recording: ${String(err)}`, "recorder", err),
        );
      } finally {
        this.finalizing = null;
      }
    })();
    return this.finalizing;
  }

  private toSession(s: RecorderSession): RecordingSession {
    return {
      id: s.id,
      status: s.state,
      startedAt: (s.startedAt ?? new Date()).toISOString(),
      elapsedSeconds: s.timer.elapsedSeconds,
      mimeType: s.mediaRecorder.mimeType,
      duration: s.requestedDuration,
      audio: { ...s.audioStatus },
      camera: s.cameraStatus,
      warnings: [...s.warnings],
    };
  }

  /** Normalizes to RecorderError, emits `recording:error`, returns it for throwing. */
  private raise(err: unknown): RecorderError {
    const error =
      err instanceof RecorderError ? err : new RecorderError("UNKNOWN", err instanceof Error ? err.message : String(err), "recorder", err);
    this.events.emit("recording:error", error);
    return error;
  }
}
