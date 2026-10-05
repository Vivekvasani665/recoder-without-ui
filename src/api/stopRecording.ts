import { pendingUpload, uploadRecordingToDrive } from "./driveIntegration";
import { recorder } from "./instance";
import type { RecordingResult, StopRecordingOptions } from "./types";

/**
 * Stop immediately, release all tracks/AudioContext, and resolve with the
 * Blob + metadata.
 *
 *   await stopRecording();                          // { status: "stopped", blob, ... }
 *   await stopRecording({ uploadToDrive: true });   // { status: "uploaded", drive: { fileId, webViewLink, ... } }
 *
 * A failed upload does not lose the recording: status is "upload-failed",
 * `driveError` says why, and `blob` is still there.
 */
export async function stopRecording(options: StopRecordingOptions = {}): Promise<RecordingResult> {
  const result = await recorder.stopRecording();
  const pending = pendingUpload(result.id); // auto-upload from startRecording({ drive: { uploadOnStop } })
  if (pending) return pending;
  if (options.uploadToDrive) return uploadRecordingToDrive(result, options.drive);
  return result;
}
