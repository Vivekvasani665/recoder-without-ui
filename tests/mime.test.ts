import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMimeType } from "../src/recorder/MediaRecorderController";
import { MIME_TYPE_CANDIDATES, getSupportedMimeType, isMimeTypeSupported } from "../src/utils/mime";
import { RecorderError } from "../src/utils/errors";

function stubSupported(types: string[]) {
  const isTypeSupported = vi.fn((t: string) => types.includes(t));
  vi.stubGlobal("MediaRecorder", Object.assign(function MediaRecorder() {}, { isTypeSupported }));
  return isTypeSupported;
}

describe("MIME selection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prefers video/webm;codecs=vp9,opus", () => {
    stubSupported([...MIME_TYPE_CANDIDATES]);
    expect(getSupportedMimeType()).toBe("video/webm;codecs=vp9,opus");
  });

  it("falls back in order using MediaRecorder.isTypeSupported", () => {
    const spy = stubSupported(["video/webm;codecs=vp8,opus", "video/webm"]);
    expect(getSupportedMimeType()).toBe("video/webm;codecs=vp8,opus");
    expect(spy).toHaveBeenCalledWith("video/webm;codecs=vp9,opus");
  });

  it("falls back to MP4 (Safari)", () => {
    stubSupported(["video/mp4"]);
    expect(getSupportedMimeType()).toBe("video/mp4");
  });

  it("returns '' (browser default) when nothing matches", () => {
    stubSupported([]);
    expect(getSupportedMimeType()).toBe("");
  });

  it("is safe when MediaRecorder is missing", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    expect(isMimeTypeSupported("video/webm")).toBe(false);
    expect(getSupportedMimeType()).toBe("");
  });

  it("rejects an explicitly requested unsupported type", () => {
    stubSupported(["video/webm"]);
    expect(() => resolveMimeType("video/x-matroska")).toThrowError(RecorderError);
    try {
      resolveMimeType("video/x-matroska");
    } catch (err) {
      expect((err as RecorderError).code).toBe("MIME_TYPE_UNSUPPORTED");
    }
    expect(resolveMimeType("video/webm")).toBe("video/webm");
  });
});
