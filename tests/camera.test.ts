import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Recorder } from "../src/recorder/Recorder";
import { RecorderError } from "../src/utils/errors";
import { FakeMediaRecorder, FakeTrack, domException, installBrowserMocks, type BrowserMocks } from "./mocks";

// Canvas/<video> compositing needs a real DOM; replace it with a fake that
// returns a recognisable output track.
const compositorOutput = new FakeTrack("video");
const compositorStop = vi.fn();
const compositorStart = vi.fn(async () => compositorOutput);
vi.mock("../src/capture/VideoCompositor", () => ({
  VideoCompositor: class {
    start = compositorStart;
    stop = compositorStop;
  },
}));

describe("camera bubble", () => {
  let mocks: BrowserMocks;
  let rec: Recorder;

  beforeEach(() => {
    mocks = installBrowserMocks();
    rec = new Recorder();
    rec.on("recording:error", () => {});
    compositorStart.mockClear();
    compositorStop.mockClear();
  });

  afterEach(async () => {
    await rec.destroy();
    vi.unstubAllGlobals();
  });

  it("is off by default: records the raw screen track, no camera prompt", async () => {
    const session = await rec.startRecording();
    expect(session.camera).toBe("disabled");
    expect(mocks.getUserMedia.mock.calls.every((c) => !(c[0] as { video?: unknown }).video)).toBe(true);
    expect(FakeMediaRecorder.last!.stream.getVideoTracks()[0]).toBe(mocks.screenVideo);
  });

  it("camera: true records the composited screen + webcam track", async () => {
    const session = await rec.startRecording({ camera: true });
    expect(session.camera).toBe("active");
    expect(compositorStart).toHaveBeenCalledOnce();
    expect(FakeMediaRecorder.last!.stream.getVideoTracks()[0]).toBe(compositorOutput);
  });

  it("releases the webcam and compositor on stop", async () => {
    await rec.startRecording({ camera: { position: "top-left" } });
    const result = await rec.stopRecording();
    expect(result.camera).toBe("active");
    expect(mocks.camera.stop).toHaveBeenCalled();
    expect(compositorStop).toHaveBeenCalled();
  });

  it("records without the camera if it is denied (not required)", async () => {
    mocks.getUserMedia.mockImplementation(async (c?: { video?: unknown }) => {
      if (c?.video) throw domException("NotAllowedError");
      return { getTracks: () => [mocks.mic], getAudioTracks: () => [mocks.mic], getVideoTracks: () => [] };
    });
    const session = await rec.startRecording({ camera: true });
    expect(session.camera).toBe("unavailable");
    expect(session.warnings.join(" ")).toMatch(/camera/i);
    expect(FakeMediaRecorder.last!.stream.getVideoTracks()[0]).toBe(mocks.screenVideo);
  });

  it("fails with CAMERA_PERMISSION_DENIED when required", async () => {
    mocks.getUserMedia.mockImplementation(async (c?: { video?: unknown }) => {
      if (c?.video) throw domException("NotAllowedError");
      return { getTracks: () => [mocks.mic], getAudioTracks: () => [mocks.mic], getVideoTracks: () => [] };
    });
    await expect(rec.startRecording({ camera: { required: true } })).rejects.toSatisfy(
      (e: unknown) => e instanceof RecorderError && e.code === "CAMERA_PERMISSION_DENIED",
    );
    expect(mocks.screenVideo.stop).toHaveBeenCalled();
  });
});
