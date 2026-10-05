/**
 * Minimal fakes for the browser media APIs so the recorder's control flow
 * can be tested in Node. They model states, events and track lifecycle —
 * not real media.
 */
import { vi } from "vitest";

export class FakeTrack extends EventTarget {
  readyState: "live" | "ended" = "live";
  readonly stop = vi.fn(() => {
    this.readyState = "ended";
  });
  constructor(
    readonly kind: "audio" | "video",
    private readonly settings: Record<string, unknown> = {},
  ) {
    super();
  }
  getSettings(): Record<string, unknown> {
    return this.settings;
  }
  /** Simulates the browser's native "Stop sharing" button. */
  endByUser(): void {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

export class FakeMediaStream {
  private readonly tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "video");
  }
}

class FakeNode {
  readonly connect = vi.fn((n: unknown) => n);
  readonly disconnect = vi.fn();
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static initialState: "running" | "suspended" = "running";
  static resumeWorks = true;
  state: "running" | "suspended" | "closed" = FakeAudioContext.initialState;
  currentTime = 0;
  readonly inputs: FakeMediaStream[] = [];
  readonly gains: { gain: { value: number } }[] = [];
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  readonly resume = vi.fn(async () => {
    if (FakeAudioContext.resumeWorks) this.state = "running";
  });
  readonly close = vi.fn(async () => {
    this.state = "closed";
  });
  createMediaStreamDestination() {
    return Object.assign(new FakeNode(), { stream: new FakeMediaStream([new FakeTrack("audio")]) });
  }
  createMediaStreamSource(stream: FakeMediaStream) {
    this.inputs.push(stream);
    return new FakeNode();
  }
  createAnalyser() {
    return Object.assign(new FakeNode(), {
      fftSize: 1024,
      getFloatTimeDomainData: (buf: Float32Array) => buf.fill(0.25),
    });
  }
  createGain() {
    const g = Object.assign(new FakeNode(), { gain: { value: 1, setTargetAtTime: vi.fn() } });
    this.gains.push(g);
    return g;
  }
}

export class FakeMediaRecorder extends EventTarget {
  static supported = new Set<string>(["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]);
  static isTypeSupported(type: string): boolean {
    return FakeMediaRecorder.supported.has(type);
  }
  static last: FakeMediaRecorder | null = null;

  state: "inactive" | "recording" | "paused" = "inactive";
  readonly mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  constructor(
    readonly stream: FakeMediaStream,
    readonly options: { mimeType?: string } = {},
  ) {
    super();
    this.mimeType = options.mimeType ?? "video/webm";
    FakeMediaRecorder.last = this;
  }
  readonly start = vi.fn(() => {
    this.state = "recording";
  });
  readonly pause = vi.fn(() => {
    this.state = "paused";
  });
  readonly resume = vi.fn(() => {
    this.state = "recording";
  });
  readonly stop = vi.fn(() => {
    this.state = "inactive";
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(2048)], { type: this.mimeType }) });
      this.dispatchEvent(new Event("stop"));
    });
  });
  emitChunk(bytes = 1024): void {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }) });
  }
}

export interface BrowserMocks {
  screenVideo: FakeTrack;
  systemAudio: FakeTrack | null;
  mic: FakeTrack;
  camera: FakeTrack;
  getDisplayMedia: ReturnType<typeof vi.fn>;
  getUserMedia: ReturnType<typeof vi.fn>;
}

export function installBrowserMocks(opts: { systemAudio?: boolean } = {}): BrowserMocks {
  const screenVideo = new FakeTrack("video", { displaySurface: "monitor" });
  const systemAudio = opts.systemAudio === false ? null : new FakeTrack("audio");
  const mic = new FakeTrack("audio");
  const camera = new FakeTrack("video");

  const getDisplayMedia = vi.fn(async (_constraints?: unknown) =>
    new FakeMediaStream([screenVideo, ...(systemAudio ? [systemAudio] : [])]),
  );
  const getUserMedia = vi.fn(async (constraints?: { video?: unknown }) =>
    constraints?.video ? new FakeMediaStream([camera]) : new FakeMediaStream([mic]),
  );

  FakeAudioContext.instances = [];
  FakeAudioContext.initialState = "running";
  FakeAudioContext.resumeWorks = true;
  FakeMediaRecorder.last = null;

  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia, getUserMedia } });
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("MediaStream", FakeMediaStream);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("AudioContext", FakeAudioContext);

  return { screenVideo, systemAudio, mic, camera, getDisplayMedia, getUserMedia };
}

export function domException(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

/** Cast a fake to the DOM type it stands in for. */
export const asStream = (s: FakeMediaStream): MediaStream => s as unknown as MediaStream;
