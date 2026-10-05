import type { VoiceIsolationProvider } from "../audio/VoiceIsolationProvider";
import { RecorderError } from "../utils/errors";

export interface ExternalVoiceIsolationOptions {
  /**
   * YOUR backend endpoint. It receives an SDP offer (Content-Type:
   * application/sdp) and must answer with an SDP answer, sending back the
   * processed audio as a WebRTC track. The backend talks to the actual
   * separation service and holds its API key.
   */
  endpoint: string;
  /** Optional short-lived token from your backend. Never the vendor secret. */
  sessionToken?: string;
  /** Default 10000 ms. */
  timeoutMs?: number;
  /** On failure, return the unprocessed input instead of throwing. Default true. */
  fallbackToPassthrough?: boolean;
  rtcConfiguration?: RTCConfiguration;
  /**
   * Replace the default WebRTC transport (e.g. WebSocket + AudioWorklet).
   * Receives the input stream and must resolve with the processed stream.
   */
  transport?: (input: MediaStream, signal: AbortSignal) => Promise<MediaStream>;
}

/**
 * Integration point for a REAL voice-isolation / speaker-separation service.
 *
 * Default transport is WebRTC (WHIP-style offer/answer to `endpoint`), so
 * audio streams to the server and back in real time:
 *
 *   browser ──(audio track, SDP offer)──▶ your backend ──▶ separation model/vendor
 *   browser ◀──(processed track, SDP answer)── your backend
 *
 * SECURITY: never put the vendor API key in browser code. Keep it on the
 * server (e.g. process.env.VOICE_ISOLATION_API_KEY). Passing `apiKey` here
 * is rejected on purpose.
 */
export class ExternalVoiceIsolationProvider implements VoiceIsolationProvider {
  readonly name = "external";
  private pc: RTCPeerConnection | null = null;
  private controller: AbortController | null = null;
  /** Last connection error, if the provider fell back to pass-through. */
  lastError: unknown = null;

  constructor(private readonly options: ExternalVoiceIsolationOptions) {
    if ("apiKey" in (options as object)) {
      throw new RecorderError(
        "VOICE_ISOLATION_FAILED",
        "Do not pass a vendor apiKey to browser code. Keep it on your server and set `endpoint` to your backend proxy.",
        "voice-isolation",
      );
    }
    if (!options.endpoint && !options.transport) {
      throw new RecorderError(
        "VOICE_ISOLATION_FAILED",
        "ExternalVoiceIsolationProvider needs an `endpoint` (your backend) or a custom `transport`.",
        "voice-isolation",
      );
    }
  }

  async process(input: MediaStream): Promise<MediaStream> {
    this.controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? 10_000;
    const timer = setTimeout(() => this.controller?.abort(), timeoutMs);
    try {
      const transport = this.options.transport ?? ((s, signal) => this.connectWebRTC(s, signal));
      const output = await transport(input, this.controller.signal);
      if (output.getAudioTracks().length === 0) throw new Error("Provider returned no audio track");
      return output;
    } catch (err) {
      this.lastError = err;
      this.closePeer();
      if (this.options.fallbackToPassthrough ?? true) {
        console.warn("[screen-recorder] External voice isolation unavailable; recording this source unprocessed.", err);
        return input;
      }
      throw new RecorderError("VOICE_ISOLATION_FAILED", `External voice isolation failed: ${String(err)}`, "voice-isolation", err);
    } finally {
      clearTimeout(timer);
    }
  }

  private async connectWebRTC(input: MediaStream, signal: AbortSignal): Promise<MediaStream> {
    if (typeof RTCPeerConnection === "undefined") throw new Error("RTCPeerConnection is not available");

    const pc = new RTCPeerConnection(this.options.rtcConfiguration);
    this.pc = pc;
    for (const track of input.getAudioTracks()) pc.addTransceiver(track, { direction: "sendrecv" });

    const remote = new Promise<MediaStream>((resolve, reject) => {
      pc.ontrack = (e) => resolve(e.streams[0] ?? new MediaStream([e.track]));
      signal.addEventListener("abort", () => reject(new Error("Timed out waiting for processed audio")));
    });

    await pc.setLocalDescription(await pc.createOffer());
    await waitForIceGathering(pc, signal);

    const res = await fetch(this.options.endpoint, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/sdp",
        ...(this.options.sessionToken ? { Authorization: `Bearer ${this.options.sessionToken}` } : {}),
      },
      body: pc.localDescription?.sdp ?? "",
    });
    if (!res.ok) throw new Error(`Backend answered HTTP ${res.status}`);
    await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });

    return remote;
  }

  private closePeer(): void {
    this.pc?.close();
    this.pc = null;
  }

  dispose(): void {
    this.controller?.abort();
    this.closePeer();
  }
}

function waitForIceGathering(pc: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
    signal.addEventListener("abort", () => reject(new Error("Timed out gathering ICE candidates")));
  });
}
