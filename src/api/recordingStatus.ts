import { recorder } from "./instance";
import type { AudioSourceKind, RecordingStatus } from "./types";

export function getRecordingStatus(): RecordingStatus {
  return recorder.getRecordingStatus();
}

/** True while recording or paused. */
export function isRecording(): boolean {
  return recorder.isRecording();
}

/** Whole seconds recorded so far (pauses excluded). */
export function getRecordingDuration(): number {
  return recorder.getRecordingDuration();
}

/** Live input level per audio source, 0..1 (e.g. `{ microphone: 0.12, system: 0 }`). */
export function getAudioLevels(): Partial<Record<AudioSourceKind, number>> {
  return recorder.getAudioLevels();
}
