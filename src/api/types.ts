import type { AudioSourceKind } from "../audio/AudioSource";
import type { VoiceIsolationProvider } from "../audio/VoiceIsolationProvider";
import type { CameraOptions } from "../capture/CaptureTypes";
import type { DriveAPI, DriveFile, RecordingDriveOptions } from "../drive/GoogleDriveTypes";
import type { RecorderError } from "../utils/errors";

export type { CameraOptions, CameraPosition } from "../capture/CaptureTypes";
export type {
  DriveAPI,
  DriveAccount,
  DriveFile,
  DriveFolder,
  DriveUploadOptions,
  DriveUploadProgress,
  GoogleDriveConfigInput,
  RecordingDriveOptions,
} from "../drive/GoogleDriveTypes";

export type { AudioSourceKind } from "../audio/AudioSource";
export type { RecorderErrorCode, RecorderErrorSource } from "../utils/errors";

export type RecordingState =
  | "idle"
  | "starting"
  | "recording"
  | "paused"
  | "stopping"
  | "stopped"
  | "error";

/** Why a recording ended. */
export type StopReason = "manual" | "duration" | "screen-ended" | "error";

/** Per-source audio state, so callers can see e.g. that system audio was not shared. */
export type AudioSourceState = "active" | "unavailable" | "disabled";

export type AudioSourcesStatus = Record<AudioSourceKind, AudioSourceState>;

/** Webcam bubble state: "active" when composited into the video. */
export type CameraState = "active" | "unavailable" | "disabled";

export interface MicrophoneOptions {
  /** Browser DSP — off by default. Ordinary noise processing, NOT voice isolation. */
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  deviceId?: string;
}

export type VoiceIsolationOptions =
  | {
      /** Pass-through. Does no speaker separation (see LocalVoiceIsolationProvider). */
      provider: "local";
      applyTo?: AudioSourceKind[];
    }
  | {
      /** Real separation via your backend, which holds the vendor credentials. */
      provider: "external";
      /** YOUR backend endpoint (never a vendor URL with a secret key). */
      endpoint: string;
      /** Optional short-lived token issued by your backend (not the vendor key). */
      sessionToken?: string;
      /** Connection timeout in ms. Default 10000. */
      timeoutMs?: number;
      /** On failure, record the unprocessed source instead of failing. Default true. */
      fallbackToPassthrough?: boolean;
      rtcConfiguration?: RTCConfiguration;
      applyTo?: AudioSourceKind[];
    }
  | {
      /** Bring your own implementation. Called once per audio source. */
      provider: () => VoiceIsolationProvider;
      applyTo?: AudioSourceKind[];
    };

export interface StartRecordingOptions {
  /** Auto-stop after this many ms of recorded time (pauses excluded). Omit to record until stopRecording(). */
  duration?: number;
  video?: {
    frameRate?: number;
    width?: number;
    height?: number;
    bitsPerSecond?: number;
  };
  /**
   * Webcam bubble burned into the recorded video (screen + round camera overlay).
   * `true` uses defaults. Off by default.
   */
  camera?: boolean | CameraOptions;
  /** Your microphone. `false` disables it. Default: enabled, all browser DSP off. */
  microphone?: MicrophoneOptions | false;
  /**
   * System/tab audio from the screen share (e.g. the client's voice in a call app).
   * `true` (default): use it if shared, otherwise mark it "unavailable".
   * `"required"`: fail with SYSTEM_AUDIO_UNAVAILABLE if it is not shared.
   * `false`: do not request it.
   */
  systemAudio?: boolean | "required";
  /** Client/remote voice, e.g. the remote MediaStream of a WebRTC call your app hosts. */
  remoteAudio?: MediaStream | MediaStream[];
  voiceIsolation?: VoiceIsolationOptions;
  /** Per-source mix level, 0..n. Default 1. */
  gains?: Partial<Record<AudioSourceKind, number>>;
  audioBitsPerSecond?: number;
  /** Preferred MIME type. Must be supported, otherwise MIME_TYPE_UNSUPPORTED. Default: auto-select. */
  mimeType?: string;
  /** MediaRecorder timeslice in ms; each slice emits `recording:data`. Default 1000. */
  timeslice?: number;
  /** Optional Google Drive upload for this recording (handled outside the recorder core). */
  drive?: RecordingDriveOptions;
}

export interface StopRecordingOptions {
  /** Upload the finished recording to Google Drive (drive must be configured + connected). */
  uploadToDrive?: boolean;
  /** Overrides for this upload (file name, folder, description). */
  drive?: Omit<RecordingDriveOptions, "uploadOnStop">;
}

/** Returned by startRecording(). */
export interface RecordingSession {
  id: string;
  status: RecordingState;
  startedAt: string;
  elapsedSeconds: number;
  mimeType: string;
  /** Requested auto-stop in ms, or null. */
  duration: number | null;
  audio: AudioSourcesStatus;
  camera: CameraState;
  warnings: string[];
}

/** Returned by getRecordingStatus(). */
export interface RecordingStatus {
  id: string | null;
  status: RecordingState;
  /** Whole seconds recorded so far (pauses excluded). */
  elapsedSeconds: number;
  elapsedMs: number;
  /** Final duration once stopped, otherwise null. */
  durationSeconds: number | null;
  startedAt: string | null;
  stoppedAt: string | null;
  stopReason: StopReason | null;
  mimeType: string | null;
  audio: AudioSourcesStatus | null;
  camera: CameraState | null;
  warnings: string[];
}

/** Returned by stopRecording(). */
export interface RecordingResult {
  id: string;
  /** "uploaded" / "upload-failed" only when a Drive upload was requested. */
  status: "stopped" | "uploaded" | "upload-failed";
  stopReason: StopReason;
  durationSeconds: number;
  durationMs: number;
  mimeType: string;
  size: number;
  blob: Blob;
  /** Compact summary of the recording. */
  recording: { durationSeconds: number; mimeType: string; size: number };
  /** Drive file when uploaded. */
  drive?: DriveFile;
  /** Why the Drive upload failed. The recording (blob) is still returned. */
  driveError?: RecorderError;
  startedAt: string;
  stoppedAt: string;
  audio: AudioSourcesStatus;
  camera: CameraState;
  warnings: string[];
}

export interface ScreenRecorderAPI {
  startRecording(options?: StartRecordingOptions): Promise<RecordingSession>;
  stopRecording(options?: StopRecordingOptions): Promise<RecordingResult>;
  pauseRecording(): void;
  resumeRecording(): void;
  getRecordingStatus(): RecordingStatus;
  isRecording(): boolean;
  getRecordingDuration(): number;
  getAudioLevels(): Partial<Record<AudioSourceKind, number>>;
  drive: DriveAPI;
  on: import("../recorder/Recorder").Recorder["on"];
  off: import("../recorder/Recorder").Recorder["off"];
}

declare global {
  interface Window {
    ScreenRecorder?: ScreenRecorderAPI;
  }
}
