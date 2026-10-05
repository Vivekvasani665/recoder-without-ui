/**
 * Script-only usage example. No UI is created: the browser's native
 * screen-share picker is the only thing the user sees.
 *
 * Note: Safari and Firefox only open the picker from a user gesture, so in
 * those browsers call demo() from inside an existing click/keydown handler
 * of your application.
 */
import {
  getRecordingStatus,
  isRecording,
  recorder,
  startRecording,
  stopRecording,
  type RecordingResult,
} from "../src/index";

recorder.on("recording:error", (err) => console.error(`[recorder] ${err.code}: ${err.message}`));
recorder.on("recording:screen-ended", () => console.log("[recorder] user clicked 'Stop sharing'"));

export async function demo(): Promise<RecordingResult | null> {
  console.log("Starting recorder...");

  const session = await startRecording(); // until stopRecording()
  console.log("Recording started", session);

  const interval = setInterval(() => {
    console.log(getRecordingStatus());
  }, 1000);

  // Stop from another command after 30 s (unless the user already stopped sharing).
  return new Promise((resolve) => {
    setTimeout(async () => {
      clearInterval(interval);
      if (!isRecording()) {
        resolve(null);
        return;
      }
      const result = await stopRecording();
      console.log("Recording stopped", {
        durationSeconds: result.durationSeconds,
        mimeType: result.mimeType,
        size: result.size,
      });
      // The application decides what to do with result.blob (upload, save, process...).
      resolve(result);
    }, 30_000);
  });
}

/** Same thing with automatic stop. */
export async function demoWithDuration(): Promise<void> {
  await startRecording({ duration: 10_000 });
  recorder.once("recording:stop", (result) => console.log("Auto-stopped after", result.durationSeconds, "s"));
}

demo().catch((err: unknown) => console.error(err));
