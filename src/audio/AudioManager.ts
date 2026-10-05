import type { AudioSourcesStatus, StartRecordingOptions, VoiceIsolationOptions } from "../api/types";
import { ExternalVoiceIsolationProvider } from "../providers/ExternalVoiceIsolationProvider";
import { LocalVoiceIsolationProvider } from "../providers/LocalVoiceIsolationProvider";
import { RecorderError } from "../utils/errors";
import { AudioMixer } from "./AudioMixer";
import type { AudioSource, AudioSourceKind } from "./AudioSource";
import { MicrophoneAudioSource } from "./MicrophoneAudioSource";
import { RemoteAudioSource } from "./RemoteAudioSource";
import { SystemAudioSource } from "./SystemAudioSource";
import type { VoiceIsolationProvider } from "./VoiceIsolationProvider";

const ALL_KINDS: AudioSourceKind[] = ["microphone", "remote", "system"];

export function createVoiceIsolationProvider(options: VoiceIsolationOptions = { provider: "local" }): VoiceIsolationProvider {
  if (typeof options.provider === "function") return options.provider();
  if (options.provider === "external") {
    const { provider: _provider, applyTo: _applyTo, ...rest } = options;
    return new ExternalVoiceIsolationProvider(rest);
  }
  return new LocalVoiceIsolationProvider();
}

export interface AudioPipelineResult {
  /** The single mixed track to record, or null if no audio source is active. */
  track: MediaStreamTrack | null;
  status: AudioSourcesStatus;
  warnings: string[];
}

/**
 *   MicrophoneAudioSource ─► provider ─┐
 *   RemoteAudioSource     ─► provider ─┼─► AudioMixer ─► MediaStreamDestination ─► MediaRecorder
 *   SystemAudioSource     ─► provider ─┘
 *
 * Every source is acquired, validated and processed independently.
 */
export class AudioManager {
  private sources: AudioSource[] = [];
  private providers: VoiceIsolationProvider[] = [];
  private mixer: AudioMixer | null = null;

  /**
   * Create the AudioContext synchronously while the user's click is still
   * "active" (before the screen picker is awaited). Without this, browsers
   * may keep it suspended and the recording's audio is silent.
   */
  prepare(): void {
    this.mixer ??= new AudioMixer();
    this.mixer.prepare();
  }

  async start(displayStream: MediaStream, options: StartRecordingOptions): Promise<AudioPipelineResult> {
    const status: AudioSourcesStatus = { microphone: "disabled", remote: "disabled", system: "disabled" };
    const warnings: string[] = [];
    const ready: { kind: AudioSourceKind; stream: MediaStream }[] = [];

    try {
      // Microphone — failures (e.g. permission denied) are fatal unless disabled.
      if (options.microphone !== false) {
        ready.push(await this.acquire(new MicrophoneAudioSource(options.microphone ?? {})));
        status.microphone = "active";
      }

      // Remote/client stream supplied by the app.
      const remote = options.remoteAudio ? [options.remoteAudio].flat() : [];
      if (remote.length > 0) {
        try {
          ready.push(await this.acquire(new RemoteAudioSource(remote)));
          status.remote = "active";
        } catch (err) {
          status.remote = "unavailable";
          warnings.push((err as Error).message);
        }
      }

      // System/tab audio from the screen share.
      const systemAudio = options.systemAudio ?? true;
      if (systemAudio) {
        try {
          ready.push(await this.acquire(new SystemAudioSource(displayStream)));
          status.system = "active";
        } catch (err) {
          if (systemAudio === "required") throw err;
          status.system = "unavailable";
          warnings.push((err as Error).message);
        }
      }

      if (ready.length === 0) {
        await this.mixer?.close();
        this.mixer = null;
        warnings.push("No audio source is active; recording video only.");
        return { track: null, status, warnings };
      }

      // Voice isolation, one provider instance per source.
      const applyTo = options.voiceIsolation?.applyTo ?? ALL_KINDS;
      const processed: { kind: AudioSourceKind; stream: MediaStream }[] = [];
      for (const { kind, stream } of ready) {
        if (!applyTo.includes(kind)) {
          processed.push({ kind, stream });
          continue;
        }
        const provider = createVoiceIsolationProvider(options.voiceIsolation);
        this.providers.push(provider);
        try {
          processed.push({ kind, stream: await provider.process(stream) });
        } catch (err) {
          throw err instanceof RecorderError
            ? err
            : new RecorderError("VOICE_ISOLATION_FAILED", `Voice isolation (${provider.name}) failed for ${kind}: ${String(err)}`, "voice-isolation", err);
        }
      }

      // Mix.
      this.mixer ??= new AudioMixer();
      const running = await this.mixer.open();
      if (!running) {
        warnings.push(
          "The browser kept the audio engine suspended (autoplay policy), so audio may be silent. Start recording from a click or key press.",
        );
      }
      for (const { kind, stream } of processed) this.mixer.addInput(kind, stream, options.gains?.[kind] ?? 1);

      return { track: this.mixer.outputTrack, status, warnings };
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  private async acquire(source: AudioSource): Promise<{ kind: AudioSourceKind; stream: MediaStream }> {
    this.sources.push(source);
    return { kind: source.kind, stream: await source.start() };
  }

  setGain(kind: AudioSourceKind, value: number): void {
    this.mixer?.setGain(kind, value);
  }

  /** Live input level per active source, 0..1. Empty when not recording. */
  getLevels(): Partial<Record<AudioSourceKind, number>> {
    return this.mixer?.getLevels() ?? {};
  }

  async stop(): Promise<void> {
    const providers = this.providers;
    this.providers = [];
    for (const p of providers) {
      try {
        await p.dispose?.();
      } catch {
        /* ignore */
      }
    }
    await this.mixer?.close();
    this.mixer = null;
    this.sources.forEach((s) => s.stop());
    this.sources = [];
  }
}
