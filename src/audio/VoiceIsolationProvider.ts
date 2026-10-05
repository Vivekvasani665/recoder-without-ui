/**
 * Voice-isolation provider contract.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT BROWSER APIS CAN AND CANNOT DO
 * ─────────────────────────────────────────────────────────────────────────────
 * getUserMedia, Web Audio and MediaRecorder have no idea WHO is speaking.
 * If you, a colleague and a TV are all heard by one microphone, the browser
 * delivers one mixed waveform. Nothing in the platform can label
 * "this is the client" vs "this is someone else in the room".
 *
 * `noiseSuppression`, volume thresholds/gates and frequency filters do NOT
 * change that: they reduce noise, and they treat every human voice the same.
 * This library therefore does not ship any of them as "voice isolation".
 *
 * What the architecture does reliably: keep each INPUT separate.
 *   microphone → your voice
 *   remote     → client's voice from your call stream
 *   system     → client's voice from the shared system/tab audio
 * Each input gets its own provider instance and is only mixed at the end.
 *
 * Removing other voices from within ONE input needs a real model —
 * target-speaker extraction, speaker/source separation and/or diarization —
 * plugged in as an implementation of this interface (see
 * ExternalVoiceIsolationProvider, or pass your own factory).
 * ─────────────────────────────────────────────────────────────────────────────
 */
export interface VoiceIsolationProvider {
  readonly name: string;
  /**
   * Take one source's stream, return the processed stream to be mixed.
   * Returning `input` unchanged is valid (pass-through).
   */
  process(input: MediaStream): Promise<MediaStream>;
  /** Release connections/models. Called when recording stops. */
  dispose?(): void | Promise<void>;
}
