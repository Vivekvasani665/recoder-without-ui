import { recorder } from "./instance";

/** Pause recording and the timer. Throws INVALID_STATE unless recording. */
export function pauseRecording(): void {
  recorder.pauseRecording();
}

/** Resume recording and the timer. Throws INVALID_STATE unless paused. */
export function resumeRecording(): void {
  recorder.resumeRecording();
}
