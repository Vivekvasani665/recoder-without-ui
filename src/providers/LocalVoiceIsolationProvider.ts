import type { VoiceIsolationProvider } from "../audio/VoiceIsolationProvider";

/**
 * Default provider: an explicit PASS-THROUGH.
 *
 * It performs NO speaker separation, NO noise gating and NO filtering, and it
 * makes no claim to remove anyone's voice. Browser APIs alone cannot tell one
 * speaker from another inside a single mixed track (see
 * audio/VoiceIsolationProvider.ts), so any "local" trick (volume threshold,
 * band-pass, noiseSuppression) would be noise reduction posing as speaker
 * isolation.
 *
 * What you get locally is source-level separation: your mic and the client's
 * audio arrive on different inputs and stay separate until the mixer.
 * For real isolation inside one input, use ExternalVoiceIsolationProvider or
 * your own provider factory.
 */
export class LocalVoiceIsolationProvider implements VoiceIsolationProvider {
  readonly name = "local-passthrough";

  async process(input: MediaStream): Promise<MediaStream> {
    return input;
  }
}
