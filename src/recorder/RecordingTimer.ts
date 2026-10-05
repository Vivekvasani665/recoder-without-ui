/**
 * Internal recording clock (no UI). Counts only time spent recording, so
 * pauses are excluded, and optionally fires a callback once a limit of
 * recorded time is reached (used for `startRecording({ duration })`).
 */
export class RecordingTimer {
  private accumulated = 0;
  private runningSince: number | null = null;
  private limitMs: number | null = null;
  private onLimit: (() => void) | null = null;
  private limitHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  start(limitMs?: number, onLimit?: () => void): void {
    this.reset();
    if (limitMs !== undefined && limitMs > 0 && onLimit) {
      this.limitMs = limitMs;
      this.onLimit = onLimit;
    }
    this.run();
  }

  pause(): void {
    if (this.runningSince === null) return;
    this.accumulated += this.now() - this.runningSince;
    this.runningSince = null;
    this.clearLimit();
  }

  resume(): void {
    if (this.runningSince !== null) return;
    this.run();
  }

  /** Freezes the clock and returns the final elapsed ms. */
  stop(): number {
    this.pause();
    this.limitMs = null;
    this.onLimit = null;
    return this.accumulated;
  }

  reset(): void {
    this.clearLimit();
    this.accumulated = 0;
    this.runningSince = null;
    this.limitMs = null;
    this.onLimit = null;
  }

  get running(): boolean {
    return this.runningSince !== null;
  }

  get elapsedMs(): number {
    return this.accumulated + (this.runningSince === null ? 0 : this.now() - this.runningSince);
  }

  get elapsedSeconds(): number {
    return Math.floor(this.elapsedMs / 1000);
  }

  private run(): void {
    this.runningSince = this.now();
    if (this.limitMs !== null && this.onLimit) {
      const remaining = Math.max(0, this.limitMs - this.accumulated);
      const cb = this.onLimit;
      this.limitHandle = setTimeout(cb, remaining);
    }
  }

  private clearLimit(): void {
    if (this.limitHandle !== null) clearTimeout(this.limitHandle);
    this.limitHandle = null;
  }
}
