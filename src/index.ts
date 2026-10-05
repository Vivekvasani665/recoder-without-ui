import { drive, recorder } from "./api/instance";
import { pauseRecording, resumeRecording } from "./api/pauseRecording";
import { getAudioLevels, getRecordingDuration, getRecordingStatus, isRecording } from "./api/recordingStatus";
import { startRecording } from "./api/startRecording";
import { stopRecording } from "./api/stopRecording";
import type { ScreenRecorderAPI } from "./api/types";

export {
  startRecording,
  stopRecording,
  pauseRecording,
  resumeRecording,
  getRecordingStatus,
  isRecording,
  getRecordingDuration,
  getAudioLevels,
  recorder,
  drive,
};

/** The same API as one object (this is what `window.ScreenRecorder` holds). */
export const ScreenRecorder: ScreenRecorderAPI = {
  startRecording,
  stopRecording,
  pauseRecording,
  resumeRecording,
  getRecordingStatus,
  isRecording,
  getRecordingDuration,
  getAudioLevels,
  drive,
  on: recorder.on,
  off: recorder.off,
};

/** Opt-in: expose the API as `window.ScreenRecorder`. */
export function installGlobal(target: Window = window): ScreenRecorderAPI {
  target.ScreenRecorder = ScreenRecorder;
  return ScreenRecorder;
}

export type * from "./api/types";
export { Recorder } from "./recorder/Recorder";
export { RecordingTimer } from "./recorder/RecordingTimer";
export type { RecorderEventMap, RecorderEventName, RecorderEventHandler } from "./events/RecorderEvents";
export { RecorderError, isRecorderError } from "./utils/errors";
export { getSupportedMimeType, isMimeTypeSupported, MIME_TYPE_CANDIDATES } from "./utils/mime";

export type { AudioSource } from "./audio/AudioSource";
export type { VoiceIsolationProvider } from "./audio/VoiceIsolationProvider";
export { MicrophoneAudioSource } from "./audio/MicrophoneAudioSource";
export { RemoteAudioSource } from "./audio/RemoteAudioSource";
export { SystemAudioSource } from "./audio/SystemAudioSource";
export { LocalVoiceIsolationProvider } from "./providers/LocalVoiceIsolationProvider";
export {
  ExternalVoiceIsolationProvider,
  type ExternalVoiceIsolationOptions,
} from "./providers/ExternalVoiceIsolationProvider";

export { GoogleDriveClient } from "./drive/GoogleDriveClient";
export { DRIVE_SCOPE, buildFileName } from "./drive/GoogleDriveConfig";
export type { HttpTransport, HttpRequest, HttpResponse } from "./drive/GoogleDriveTypes";

// Optional helpers — never called by the recorder itself.
export { uploadRecording, downloadRecording, type UploadOptions, type UploadResult } from "./utils/upload";
