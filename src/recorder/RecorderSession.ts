import type { AudioSourcesStatus, CameraState, RecordingState, StopReason } from "../api/types";
import { AudioManager } from "../audio/AudioManager";
import { CameraCapture } from "../capture/CameraCapture";
import { ScreenCapture } from "../capture/ScreenCapture";
import { VideoCompositor } from "../capture/VideoCompositor";
import { createRecordingId } from "../utils/ids";
import { MediaRecorderController } from "./MediaRecorderController";
import { RecordingTimer } from "./RecordingTimer";

/**
 * Everything belonging to ONE recording: id, timestamps, timer and the
 * media resources. A new session is created for every startRecording().
 */
export class RecorderSession {
  readonly id = createRecordingId();
  readonly screen = new ScreenCapture();
  readonly audio = new AudioManager();
  readonly camera = new CameraCapture();
  readonly compositor = new VideoCompositor();
  readonly mediaRecorder = new MediaRecorderController();
  readonly timer = new RecordingTimer();

  state: RecordingState = "starting";
  startedAt: Date | null = null;
  stoppedAt: Date | null = null;
  stopReason: StopReason | null = null;
  durationMs: number | null = null;
  requestedDuration: number | null = null;
  audioStatus: AudioSourcesStatus = { microphone: "disabled", remote: "disabled", system: "disabled" };
  cameraStatus: CameraState = "disabled";
  warnings: string[] = [];
  /** Set if the user stopped sharing while start() was still in progress. */
  screenEndedDuringStart = false;

  /** Release every captured resource. Safe to call more than once. */
  async release(): Promise<void> {
    this.timer.stop();
    this.mediaRecorder.release();
    this.compositor.stop();
    this.camera.stop();
    this.screen.stop();
    await this.audio.stop();
  }
}
