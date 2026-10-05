/**
 * End-to-end through the public API: record → stop → upload to Drive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenRecorder, drive, recorder } from "../src/index";
import { RecorderError } from "../src/utils/errors";
import { FakeDrive, apiError, isChunkPut } from "./driveFake";
import { installBrowserMocks, type BrowserMocks } from "./mocks";

let mocks: BrowserMocks;
let fake: FakeDrive;

beforeEach(() => {
  mocks = installBrowserMocks();
  fake = new FakeDrive();
  drive.configure({ tokenProvider: async () => "tok-1", transport: fake.transport, retryBaseDelayMs: 0 });
  void drive.setFolder(null);
  recorder.on("recording:error", () => {});
});

afterEach(async () => {
  if (ScreenRecorder.isRecording()) await ScreenRecorder.stopRecording();
  vi.unstubAllGlobals();
});

describe("stopRecording({ uploadToDrive: true })", () => {
  it("stops, uploads and returns Drive metadata", async () => {
    const progress = vi.fn();
    const off = ScreenRecorder.on("drive:upload:progress", progress);

    await ScreenRecorder.startRecording();
    const result = await ScreenRecorder.stopRecording({ uploadToDrive: true });
    off();

    expect(result.status).toBe("uploaded");
    expect(result.recording).toEqual({ durationSeconds: expect.any(Number), mimeType: "video/webm;codecs=vp9,opus", size: 2048 });
    expect(result.drive).toMatchObject({
      fileId: expect.any(String),
      fileName: expect.stringMatching(/^recording-.*\.webm$/),
      webViewLink: expect.stringContaining("drive.google.com"),
      webContentLink: expect.any(String),
    });
    expect(result.blob).toBeInstanceOf(Blob);
    expect(progress.mock.calls.at(-1)![0]).toMatchObject({ percentage: 100, recordingId: result.id });
    // Tracks were released before uploading.
    expect(mocks.screenVideo.stop).toHaveBeenCalled();
  });

  it("plain stopRecording() does not upload", async () => {
    await ScreenRecorder.startRecording();
    const result = await ScreenRecorder.stopRecording();
    expect(result.status).toBe("stopped");
    expect(result.drive).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
  });

  it("keeps the recording when the upload fails", async () => {
    fake.faults.push((r) => (isChunkPut(r) ? apiError(403, "storageQuotaExceeded") : undefined));
    await ScreenRecorder.startRecording();
    const result = await ScreenRecorder.stopRecording({ uploadToDrive: true, drive: { fileName: "demo" } });
    expect(result.status).toBe("upload-failed");
    expect(result.driveError).toBeInstanceOf(RecorderError);
    expect(result.driveError!.code).toBe("DRIVE_UPLOAD_FAILED");
    expect(result.blob.size).toBe(2048);
  });
});

describe("startRecording({ drive: { uploadOnStop: true } })", () => {
  it("uploads automatically on stopRecording() with the custom file name", async () => {
    await ScreenRecorder.startRecording({ drive: { uploadOnStop: true, fileName: "client-demo-recording.webm" } });
    const result = await ScreenRecorder.stopRecording();
    expect(result.status).toBe("uploaded");
    expect(result.drive!.fileName).toBe("client-demo-recording.webm");
  });

  it("also uploads when the user clicks the browser's Stop sharing", async () => {
    const complete = new Promise((resolve) => ScreenRecorder.on("drive:upload:complete", resolve));
    await ScreenRecorder.startRecording({ drive: { uploadOnStop: true } });
    mocks.screenVideo.endByUser();
    await complete;
    const result = await ScreenRecorder.stopRecording(); // returns the finished upload
    expect(result.stopReason).toBe("screen-ended");
    expect(result.status).toBe("uploaded");
  });

  it("uploads into the folder set with drive.setFolder()", async () => {
    await ScreenRecorder.drive.setFolder({ folderId: "folder-1" });
    await ScreenRecorder.startRecording({ drive: { uploadOnStop: true } });
    const result = await ScreenRecorder.stopRecording();
    expect(result.drive!.folderId).toBe("folder-1");
  });

  it("fails before the screen prompt if Drive isn't configured", async () => {
    const { GoogleDriveClient } = await import("../src/drive/GoogleDriveClient");
    // Simulate an unconfigured client by swapping the config out.
    const unconfigured = new GoogleDriveClient({ emit: () => {} });
    const spy = vi.spyOn(drive, "isConfigured").mockImplementation(() => unconfigured.isConfigured());
    await expect(ScreenRecorder.startRecording({ drive: { uploadOnStop: true } })).rejects.toMatchObject({
      code: "DRIVE_INVALID_CONFIGURATION",
    });
    expect(mocks.getDisplayMedia).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("recorder still works without Drive", () => {
  it("records and stops with Drive never configured or touched", async () => {
    await ScreenRecorder.startRecording();
    expect((await ScreenRecorder.stopRecording()).status).toBe("stopped");
    expect(fake.requests).toHaveLength(0);
  });
});
