import { assertDriveReady, rememberDriveOptions } from "./driveIntegration";
import { recorder } from "./instance";
import type { RecordingSession, StartRecordingOptions } from "./types";

/**
 * Start recording. Opens the browser's native screen picker (the only UI),
 * then records screen video + the processed audio mix.
 *
 *   await startRecording();                                 // until stopRecording()
 *   await startRecording({ duration: 60000 });              // auto-stops after 60 s
 *   await startRecording({ drive: { uploadOnStop: true } }); // upload to Drive when it ends
 *
 * Rejects with a RecorderError (e.g. SCREEN_PERMISSION_DENIED, ALREADY_RECORDING).
 */
export function startRecording(options?: StartRecordingOptions): Promise<RecordingSession> {
  try {
    assertDriveReady(options);
  } catch (err) {
    return Promise.reject(err);
  }
  // recorder.startRecording must be called synchronously (user-gesture rules).
  return recorder.startRecording(options).then((session) => {
    rememberDriveOptions(session.id, options?.drive);
    return session;
  });
}
