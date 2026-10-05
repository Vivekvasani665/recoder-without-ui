import { RecorderError } from "../utils/errors";
import type { AudioSourceKind } from "./AudioSource";

/**
 * Final stage: one MediaStreamAudioSourceNode → GainNode per source, summed
 * into a single MediaStreamAudioDestinationNode whose track is recorded.
 * Nothing is routed to the speakers, so there is no monitoring/feedback.
 *
 * Autoplay policy: browsers keep an AudioContext "suspended" (silent) unless
 * it is created/resumed during a user gesture. startRecording() awaits the
 * screen picker, which outlives the gesture, so the context must be created
 * up-front with `prepare()` — synchronously, before the first await.
 */
export class AudioMixer {
  private ctx: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private readonly inputs = new Map<
    AudioSourceKind,
    { node: MediaStreamAudioSourceNode; gain: GainNode; analyser: AnalyserNode; buffer: Float32Array<ArrayBuffer> }
  >();

  /** Create (and resume) the AudioContext now. Call synchronously inside the user gesture. */
  prepare(): void {
    if (this.ctx) return;
    const Ctx: typeof AudioContext | undefined =
      typeof AudioContext !== "undefined"
        ? AudioContext
        : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) {
      throw new RecorderError("AUDIO_INIT_FAILED", "Web Audio (AudioContext) is not available in this browser.", "audio");
    }
    try {
      this.ctx = new Ctx({ latencyHint: "interactive" });
      // resume() started inside the gesture is what unlocks audio in Safari/Chrome.
      if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => undefined);
    } catch (err) {
      this.ctx = null;
      throw new RecorderError("AUDIO_INIT_FAILED", `Could not create the AudioContext: ${String(err)}`, "audio", err);
    }
  }

  /**
   * Finish setup. Returns false if the browser still keeps the context
   * suspended (audio would be silent).
   */
  async open(): Promise<boolean> {
    this.prepare();
    const ctx = this.ctx!;
    try {
      if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
      this.destination = ctx.createMediaStreamDestination();
    } catch (err) {
      await this.close();
      throw new RecorderError("AUDIO_INIT_FAILED", `Could not create the audio mixer: ${String(err)}`, "audio", err);
    }
    return ctx.state === "running";
  }

  addInput(kind: AudioSourceKind, stream: MediaStream, gain = 1): void {
    if (!this.ctx || !this.destination) {
      throw new RecorderError("AUDIO_INIT_FAILED", "AudioMixer.addInput called before open().", "audio");
    }
    try {
      const node = this.ctx.createMediaStreamSource(stream);
      const gainNode = this.ctx.createGain();
      gainNode.gain.value = gain;
      // Level meter tap (does not affect the recording).
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;
      node.connect(gainNode);
      node.connect(analyser);
      gainNode.connect(this.destination);
      this.inputs.set(kind, { node, gain: gainNode, analyser, buffer: new Float32Array(analyser.fftSize) });
    } catch (err) {
      throw new RecorderError("AUDIO_INIT_FAILED", `Could not connect ${kind} audio: ${String(err)}`, "audio", err);
    }
  }

  setGain(kind: AudioSourceKind, value: number): void {
    const input = this.inputs.get(kind);
    if (input && this.ctx) input.gain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.02);
  }

  /** Current input level per active source, 0..1 (RMS). */
  getLevels(): Partial<Record<AudioSourceKind, number>> {
    const levels: Partial<Record<AudioSourceKind, number>> = {};
    for (const [kind, { analyser, buffer }] of this.inputs) {
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
      levels[kind] = Math.min(1, Math.sqrt(sum / buffer.length));
    }
    return levels;
  }

  get state(): AudioContextState | "closed" {
    return this.ctx?.state ?? "closed";
  }

  get outputTrack(): MediaStreamTrack | null {
    return this.destination?.stream.getAudioTracks()[0] ?? null;
  }

  async close(): Promise<void> {
    for (const { node, gain, analyser } of this.inputs.values()) {
      node.disconnect();
      gain.disconnect();
      analyser.disconnect();
    }
    this.inputs.clear();
    this.destination?.stream.getTracks().forEach((t) => t.stop());
    this.destination = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== "closed") await ctx.close().catch(() => undefined);
  }
}
