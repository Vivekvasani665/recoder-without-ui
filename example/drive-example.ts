/**
 * Script-only Google Drive example: record, stop, upload, log the link.
 * No upload UI. Google's own consent popup is the only thing shown, so call
 * connect() from an existing click/keydown handler of your app.
 */
import { ScreenRecorder } from "../src/index";

ScreenRecorder.drive.configure({ clientId: "YOUR_CLIENT_ID.apps.googleusercontent.com" });

ScreenRecorder.on("drive:upload:progress", (p) => console.log(`Uploading… ${p.percentage}%`));
ScreenRecorder.on("drive:upload:error", ({ error }) => console.error(`[drive] ${error.code}: ${error.message}`));

export async function connectDrive(): Promise<void> {
  const account = await ScreenRecorder.drive.connect();
  console.log("Connected to Drive as", account?.email);
  await ScreenRecorder.drive.createFolder("Screen recordings", { select: true });
}

export async function recordAndUpload(): Promise<void> {
  await ScreenRecorder.startRecording();
  console.log(ScreenRecorder.getRecordingStatus());

  // …later, from another command:
  const result = await ScreenRecorder.stopRecording({ uploadToDrive: true });
  if (result.status === "uploaded" && result.drive) {
    console.log("Drive link:", result.drive.webViewLink);
  } else {
    console.warn("Upload failed, recording kept locally:", result.driveError?.message, result.blob);
  }
}

/** Fully automatic: uploads whenever the recording ends. */
export async function recordWithAutoUpload(): Promise<void> {
  await ScreenRecorder.startRecording({
    duration: 60_000,
    drive: { uploadOnStop: true, fileName: "client-demo-recording.webm" },
  });
  ScreenRecorder.on("drive:upload:complete", ({ file }) => console.log("Uploaded:", file.webViewLink));
}
