/**
 * Glue between a finished recording and Google Drive. Lives in the API
 * layer so the recorder core never depends on Drive.
 */
import type { RecordingDriveOptions } from "../drive/GoogleDriveTypes";
import { RecorderError } from "../utils/errors";
import { drive, recorder } from "./instance";
import type { RecordingResult, StartRecordingOptions } from "./types";

const driveOptionsBySession = new Map<string, RecordingDriveOptions>();
let lastUpload: { id: string; promise: Promise<RecordingResult> } | null = null;

/** Fail fast — before any screen prompt — if an auto-upload can't possibly work. */
export function assertDriveReady(options?: StartRecordingOptions): void {
  if (!options?.drive?.uploadOnStop) return;
  if (!drive.isConfigured()) {
    throw new RecorderError(
      "DRIVE_INVALID_CONFIGURATION",
      "drive.uploadOnStop needs Google Drive configured: ScreenRecorder.drive.configure({ clientId }).",
      "drive",
    );
  }
}

export function rememberDriveOptions(sessionId: string, options?: RecordingDriveOptions): void {
  if (options) driveOptionsBySession.set(sessionId, options);
}

/** Starts (once) the Drive upload for a finished recording. Never rejects. */
export function uploadRecordingToDrive(
  result: RecordingResult,
  overrides: Omit<RecordingDriveOptions, "uploadOnStop"> = {},
): Promise<RecordingResult> {
  if (lastUpload?.id === result.id) return lastUpload.promise;
  const opts = { ...driveOptionsBySession.get(result.id), ...overrides };
  driveOptionsBySession.delete(result.id);

  const promise = drive
    .upload(result.blob, {
      fileName: opts.fileName,
      folderId: opts.folderId,
      description: opts.description,
      mimeType: result.mimeType,
      recordingId: result.id,
    })
    .then((file): RecordingResult => ({ ...result, status: "uploaded", drive: file }))
    .catch((error: unknown): RecordingResult => ({
      ...result,
      status: "upload-failed",
      driveError: error instanceof RecorderError ? error : new RecorderError("DRIVE_UPLOAD_FAILED", String(error), "drive", error),
    }));
  lastUpload = { id: result.id, promise };
  return promise;
}

export function pendingUpload(recordingId: string): Promise<RecordingResult> | null {
  return lastUpload?.id === recordingId ? lastUpload.promise : null;
}

// Auto-upload for every way a recording can end (stopRecording, duration, "Stop sharing").
recorder.on("recording:stop", (result) => {
  if (driveOptionsBySession.get(result.id)?.uploadOnStop) void uploadRecordingToDrive(result);
  else driveOptionsBySession.delete(result.id);
});
