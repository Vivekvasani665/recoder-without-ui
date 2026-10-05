import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Recorder } from "../src/recorder/Recorder";
import { LocalVoiceIsolationProvider } from "../src/providers/LocalVoiceIsolationProvider";
import { ExternalVoiceIsolationProvider } from "../src/providers/ExternalVoiceIsolationProvider";
import type { VoiceIsolationProvider } from "../src/audio/VoiceIsolationProvider";
import { RecorderError } from "../src/utils/errors";
import {
  FakeAudioContext,
  FakeMediaRecorder,
  FakeMediaStream,
  FakeTrack,
  asStream,
  domException,
  installBrowserMocks,
  type BrowserMocks,
} from "./mocks";

async function expectCode(promise: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (err) {
    expect(err).toBeInstanceOf(RecorderError);
    expect((err as RecorderError).code).toBe(code);
    return;
  }
  throw new Error(`expected RecorderError ${code}`);
}

const nextStop = (rec: Recorder) => new Promise((resolve) => rec.once("recording:stop", resolve));

describe("Recorder", () => {
  let mocks: BrowserMocks;
  let rec: Recorder;

  beforeEach(() => {
    mocks = installBrowserMocks();
    rec = new Recorder();
    rec.on("recording:error", () => {}); // keep tests quiet
  });

  afterEach(async () => {
    await rec.destroy();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("requests no permission until startRecording() is called", () => {
    expect(mocks.getDisplayMedia).not.toHaveBeenCalled();
    expect(mocks.getUserMedia).not.toHaveBeenCalled();
    expect(rec.getRecordingStatus().status).toBe("idle");
  });

  // ─── Test 1: start ───────────────────────────────────────────────────────
  describe("startRecording()", () => {
    it("starts recording and returns a session", async () => {
      const onStart = vi.fn();
      rec.on("recording:start", onStart);

      const session = await rec.startRecording();

      expect(session).toMatchObject({ status: "recording", elapsedSeconds: 0, duration: null });
      expect(session.id).toEqual(expect.any(String));
      expect(new Date(session.startedAt).toString()).not.toBe("Invalid Date");
      expect(session.mimeType).toBe("video/webm;codecs=vp9,opus");
      expect(onStart).toHaveBeenCalledWith(session);
      expect(rec.isRecording()).toBe(true);
    });

    it("captures the screen via getDisplayMedia, then the mic separately", async () => {
      await rec.startRecording();
      expect(mocks.getDisplayMedia.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.getUserMedia.mock.invocationCallOrder[0],
      );
      const constraints = mocks.getDisplayMedia.mock.calls[0][0] as { video: { displaySurface: string } };
      expect(constraints.video.displaySurface).toBe("monitor");
    });

    it("keeps browser mic DSP off by default and honours overrides", async () => {
      await rec.startRecording();
      const audio = (mocks.getUserMedia.mock.calls[0][0] as { audio: Record<string, unknown> }).audio;
      expect(audio).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
      await rec.stopRecording();

      await rec.startRecording({ microphone: { echoCancellation: true } });
      const audio2 = (mocks.getUserMedia.mock.calls[1][0] as { audio: Record<string, unknown> }).audio;
      expect(audio2).toMatchObject({ echoCancellation: true, noiseSuppression: false });
    });

    it("records screen video + ONE mixed audio track built from separate inputs", async () => {
      await rec.startRecording();
      const ctx = FakeAudioContext.instances[0];
      expect(ctx.inputs).toHaveLength(2); // microphone + system, each its own input
      const recorded = FakeMediaRecorder.last!.stream;
      expect(recorded.getVideoTracks()[0]).toBe(mocks.screenVideo);
      expect(recorded.getAudioTracks()).toHaveLength(1);
      expect(recorded.getAudioTracks()[0]).not.toBe(mocks.mic);
    });

    it("adds remote (client) audio as its own input without stopping caller tracks", async () => {
      const remoteTrack = new FakeTrack("audio");
      const session = await rec.startRecording({ remoteAudio: asStream(new FakeMediaStream([remoteTrack])) });
      expect(session.audio).toEqual({ microphone: "active", remote: "active", system: "active" });
      expect(FakeAudioContext.instances[0].inputs).toHaveLength(3);
      await rec.stopRecording();
      expect(remoteTrack.stop).not.toHaveBeenCalled();
    });

    it("applies per-source gains", async () => {
      await rec.startRecording({ gains: { microphone: 0.5, system: 1.5 } });
      expect(FakeAudioContext.instances[0].gains.map((g) => g.gain.value)).toEqual([0.5, 1.5]);
    });
  });

  describe("audio engine unlock (autoplay policy)", () => {
    it("creates the AudioContext synchronously, before the screen picker is awaited", () => {
      void rec.startRecording().catch(() => undefined);
      // Still inside the same synchronous turn as the click:
      expect(FakeAudioContext.instances).toHaveLength(1);
      expect(FakeAudioContext.instances[0].resume).toHaveBeenCalledTimes(0); // already running in this fake
    });

    it("resumes a suspended context created in the gesture", async () => {
      FakeAudioContext.initialState = "suspended";
      const session = await rec.startRecording();
      expect(FakeAudioContext.instances[0].resume).toHaveBeenCalled();
      expect(FakeAudioContext.instances[0].state).toBe("running");
      expect(session.warnings.join(" ")).not.toMatch(/suspended/);
    });

    it("warns when the browser refuses to start audio", async () => {
      FakeAudioContext.initialState = "suspended";
      FakeAudioContext.resumeWorks = false;
      const session = await rec.startRecording();
      expect(session.warnings.join(" ")).toMatch(/suspended/);
    });

    it("reports live audio levels per source while recording", async () => {
      expect(rec.getAudioLevels()).toEqual({});
      await rec.startRecording();
      expect(rec.getAudioLevels()).toEqual({ microphone: 0.25, system: 0.25 });
      await rec.stopRecording();
      expect(rec.getAudioLevels()).toEqual({});
    });
  });

  // ─── Test 2: status ──────────────────────────────────────────────────────
  describe("getRecordingStatus() / getRecordingDuration()", () => {
    it("reports status and elapsed time from the internal timer", async () => {
      vi.useFakeTimers({ now: 0 });
      await rec.startRecording();
      vi.setSystemTime(37_400);

      expect(rec.getRecordingStatus()).toMatchObject({
        status: "recording",
        elapsedSeconds: 37,
        durationSeconds: null,
        stoppedAt: null,
      });
      expect(rec.getRecordingDuration()).toBe(37);
    });

    it("excludes paused time", async () => {
      vi.useFakeTimers({ now: 0 });
      await rec.startRecording();
      vi.setSystemTime(10_000);
      rec.pauseRecording();
      vi.setSystemTime(70_000);
      expect(rec.getRecordingStatus()).toMatchObject({ status: "paused", elapsedSeconds: 10 });
      rec.resumeRecording();
      vi.setSystemTime(75_000);
      expect(rec.getRecordingDuration()).toBe(15);
    });
  });

  // ─── Test 3: stop ────────────────────────────────────────────────────────
  describe("stopRecording()", () => {
    it("stops immediately, returns the Blob and releases everything", async () => {
      vi.useFakeTimers({ now: 0 });
      await rec.startRecording();
      FakeMediaRecorder.last!.emitChunk(1000);
      vi.setSystemTime(42_000);

      const result = await rec.stopRecording();

      expect(result).toMatchObject({
        status: "stopped",
        stopReason: "manual",
        durationSeconds: 42,
        mimeType: "video/webm;codecs=vp9,opus",
        size: 1000 + 2048,
      });
      expect(result.blob).toBeInstanceOf(Blob);
      expect(result.blob.size).toBe(result.size);
      expect(FakeMediaRecorder.last!.stop).toHaveBeenCalled();
      // Tracks released.
      expect(mocks.screenVideo.stop).toHaveBeenCalled();
      expect(mocks.systemAudio!.stop).toHaveBeenCalled();
      expect(mocks.mic.stop).toHaveBeenCalled();
      expect(FakeAudioContext.instances[0].state).toBe("closed");
      // Timer stopped.
      vi.setSystemTime(99_000);
      expect(rec.getRecordingStatus()).toMatchObject({ status: "stopped", elapsedSeconds: 42, durationSeconds: 42 });
      expect(rec.isRecording()).toBe(false);
    });

    it("emits recording:data for chunks", async () => {
      const onData = vi.fn();
      rec.on("recording:data", onData);
      await rec.startRecording();
      FakeMediaRecorder.last!.emitChunk(500);
      await rec.stopRecording();
      expect(onData).toHaveBeenCalledTimes(2);
      expect(onData.mock.calls[1][0]).toMatchObject({ totalChunks: 2, totalSize: 2548 });
    });

    it("multiple stop calls resolve to the same result", async () => {
      await rec.startRecording();
      const [a, b] = await Promise.all([rec.stopRecording(), rec.stopRecording()]);
      expect(a).toBe(b);
      expect(await rec.stopRecording()).toBe(a);
      expect(FakeMediaRecorder.last!.stop).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Test 4: automatic duration ──────────────────────────────────────────
  describe("startRecording({ duration })", () => {
    it("stops automatically after the duration", async () => {
      vi.useFakeTimers({ now: 0 });
      const stopped = nextStop(rec);
      await rec.startRecording({ duration: 10_000 });

      vi.advanceTimersByTime(9_999);
      expect(rec.getRecordingStatus().status).toBe("recording");

      vi.advanceTimersByTime(1);
      const result = (await stopped) as { stopReason: string; durationSeconds: number; blob: Blob };
      expect(result.stopReason).toBe("duration");
      expect(result.durationSeconds).toBe(10);
      expect(result.blob).toBeInstanceOf(Blob);
      expect(rec.getRecordingStatus().status).toBe("stopped");
      // A later stopRecording() still returns that result.
      expect((await rec.stopRecording()).stopReason).toBe("duration");
    });

    it("rejects an invalid duration before prompting", async () => {
      await expectCode(rec.startRecording({ duration: -5 }), "INVALID_OPTIONS");
      expect(mocks.getDisplayMedia).not.toHaveBeenCalled();
    });
  });

  // ─── Browser "Stop sharing" ──────────────────────────────────────────────
  describe("native Stop sharing", () => {
    it("finalizes automatically with stopReason 'screen-ended'", async () => {
      const onEnded = vi.fn();
      rec.on("recording:screen-ended", onEnded);
      const stopped = nextStop(rec);
      await rec.startRecording();

      mocks.screenVideo.endByUser();
      const result = (await stopped) as { stopReason: string; blob: Blob };

      expect(onEnded).toHaveBeenCalledOnce();
      expect(result.stopReason).toBe("screen-ended");
      expect(result.blob).toBeInstanceOf(Blob);
      expect(rec.getRecordingStatus().status).toBe("stopped");
      expect(mocks.mic.stop).toHaveBeenCalled();
    });

    it("also works while paused", async () => {
      const stopped = nextStop(rec);
      await rec.startRecording();
      rec.pauseRecording();
      mocks.screenVideo.endByUser();
      await stopped;
      expect(rec.getRecordingStatus().stopReason).toBe("screen-ended");
    });
  });

  // ─── Invalid states & errors ─────────────────────────────────────────────
  describe("invalid states", () => {
    it("start while already recording", async () => {
      await rec.startRecording();
      await expectCode(rec.startRecording(), "ALREADY_RECORDING");
      expect(rec.getRecordingStatus().status).toBe("recording");
    });

    it("stop while not recording", async () => {
      await expectCode(rec.stopRecording(), "NOT_RECORDING");
    });

    it("pause while stopped / idle", async () => {
      await expectCode(() => rec.pauseRecording(), "INVALID_STATE");
      await rec.startRecording();
      await rec.stopRecording();
      await expectCode(() => rec.pauseRecording(), "INVALID_STATE");
    });

    it("resume while not paused", async () => {
      await rec.startRecording();
      await expectCode(() => rec.resumeRecording(), "INVALID_STATE");
    });

    it("emits recording:error with the typed error", async () => {
      const onError = vi.fn();
      rec.on("recording:error", onError);
      await rec.stopRecording().catch(() => undefined);
      expect(onError.mock.calls[0][0]).toBeInstanceOf(RecorderError);
    });
  });

  describe("permission and capability errors", () => {
    it("screen permission denied", async () => {
      mocks.getDisplayMedia.mockRejectedValueOnce(domException("NotAllowedError"));
      await expectCode(rec.startRecording(), "SCREEN_PERMISSION_DENIED");
      expect(mocks.getUserMedia).not.toHaveBeenCalled();
      expect(rec.getRecordingStatus().status).toBe("error");
    });

    it("microphone permission denied releases the screen", async () => {
      mocks.getUserMedia.mockRejectedValueOnce(domException("NotAllowedError"));
      await expectCode(rec.startRecording(), "MICROPHONE_PERMISSION_DENIED");
      expect(mocks.screenVideo.stop).toHaveBeenCalled();
    });

    it("microphone: false skips the microphone", async () => {
      const session = await rec.startRecording({ microphone: false });
      expect(mocks.getUserMedia).not.toHaveBeenCalled();
      expect(session.audio.microphone).toBe("disabled");
    });

    it.each([
      ["NotFoundError", "DEVICE_NOT_FOUND"],
      ["AbortError", "CAPTURE_ABORTED"],
      ["SecurityError", "INSECURE_CONTEXT"],
      ["NotReadableError", "DEVICE_IN_USE"],
    ])("maps %s to %s", async (name, code) => {
      mocks.getDisplayMedia.mockRejectedValueOnce(domException(name));
      await expectCode(rec.startRecording(), code);
    });

    it("can start again after a failure", async () => {
      mocks.getDisplayMedia.mockRejectedValueOnce(domException("NotAllowedError"));
      await rec.startRecording().catch(() => undefined);
      expect((await rec.startRecording()).status).toBe("recording");
    });

    it("MediaRecorder unsupported", async () => {
      vi.stubGlobal("MediaRecorder", undefined);
      await expectCode(rec.startRecording(), "MEDIARECORDER_UNSUPPORTED");
      expect(mocks.getDisplayMedia).not.toHaveBeenCalled();
    });

    it("getDisplayMedia unsupported", async () => {
      vi.stubGlobal("navigator", { mediaDevices: {} });
      await expectCode(rec.startRecording(), "UNSUPPORTED_BROWSER");
    });

    it("unsupported MIME type", async () => {
      await expectCode(rec.startRecording({ mimeType: "video/x-matroska" }), "MIME_TYPE_UNSUPPORTED");
      expect(mocks.getDisplayMedia).not.toHaveBeenCalled();
    });

    it("audio initialization failure", async () => {
      vi.stubGlobal("AudioContext", undefined);
      await expectCode(rec.startRecording(), "AUDIO_INIT_FAILED");
      // Detected while preparing audio, before any permission prompt.
      expect(mocks.getDisplayMedia).not.toHaveBeenCalled();
    });

    it("screen sharing ended while starting", async () => {
      mocks.getUserMedia.mockImplementationOnce(async () => {
        mocks.screenVideo.endByUser();
        return new FakeMediaStream([mocks.mic]);
      });
      await expectCode(rec.startRecording(), "SCREEN_SHARE_ENDED");
    });
  });

  describe("system audio availability", () => {
    beforeEach(() => {
      vi.unstubAllGlobals();
      mocks = installBrowserMocks({ systemAudio: false });
    });

    it("records anyway and reports system audio as unavailable", async () => {
      const session = await rec.startRecording();
      expect(session.audio.system).toBe("unavailable");
      expect(session.warnings.join(" ")).toMatch(/system audio/i);
      expect(rec.getRecordingStatus().audio?.system).toBe("unavailable");
    });

    it("fails with SYSTEM_AUDIO_UNAVAILABLE when required", async () => {
      await expectCode(rec.startRecording({ systemAudio: "required" }), "SYSTEM_AUDIO_UNAVAILABLE");
      expect(mocks.screenVideo.stop).toHaveBeenCalled();
    });
  });

  describe("voice isolation providers", () => {
    it("local provider is an explicit pass-through", async () => {
      const input = asStream(new FakeMediaStream([new FakeTrack("audio")]));
      expect(await new LocalVoiceIsolationProvider().process(input)).toBe(input);
    });

    it("uses a custom provider per source and disposes it on stop", async () => {
      const created: VoiceIsolationProvider[] = [];
      const factory = () => {
        const p: VoiceIsolationProvider = {
          name: "test",
          process: vi.fn(async (s: MediaStream) => s),
          dispose: vi.fn(),
        };
        created.push(p);
        return p;
      };
      await rec.startRecording({ voiceIsolation: { provider: factory, applyTo: ["microphone"] } });
      expect(created).toHaveLength(1);
      expect(created[0].process).toHaveBeenCalledOnce();
      await rec.stopRecording();
      expect(created[0].dispose).toHaveBeenCalled();
    });

    it("external provider refuses a vendor apiKey", () => {
      expect(
        () => new ExternalVoiceIsolationProvider({ endpoint: "/api/iso", apiKey: "sk" } as never),
      ).toThrowError(/apiKey/);
    });

    it("external provider uses its transport's processed stream", async () => {
      const processed = asStream(new FakeMediaStream([new FakeTrack("audio")]));
      const p = new ExternalVoiceIsolationProvider({ endpoint: "/api/iso", transport: async () => processed });
      expect(await p.process(asStream(new FakeMediaStream([new FakeTrack("audio")])))).toBe(processed);
    });

    it("external provider falls back to pass-through when the backend is unreachable", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const input = asStream(new FakeMediaStream([new FakeTrack("audio")]));
      const p = new ExternalVoiceIsolationProvider({ endpoint: "/api/iso" }); // no RTCPeerConnection in Node
      expect(await p.process(input)).toBe(input);
      expect(p.lastError).toBeTruthy();
    });

    it("external provider can be strict", async () => {
      const p = new ExternalVoiceIsolationProvider({
        endpoint: "/api/iso",
        fallbackToPassthrough: false,
        transport: async () => {
          throw new Error("down");
        },
      });
      await expectCode(p.process(asStream(new FakeMediaStream([new FakeTrack("audio")]))), "VOICE_ISOLATION_FAILED");
    });
  });
});
