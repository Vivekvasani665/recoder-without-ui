/**
 * One logical audio input. Each source is captured, processed and gain-staged
 * on its own; they are only combined in AudioMixer, the last step before
 * MediaRecorder.
 */
export type AudioSourceKind = "microphone" | "remote" | "system";

export interface AudioSource {
  readonly kind: AudioSourceKind;
  /** Acquire the source. Throws a RecorderError if it is unavailable. */
  start(): Promise<MediaStream>;
  /** Release whatever this source acquired. Must be safe to call twice. */
  stop(): void;
}
