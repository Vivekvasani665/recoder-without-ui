import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingTimer } from "../src/recorder/RecordingTimer";

describe("RecordingTimer", () => {
  let now = 0;
  const clock = () => now;

  beforeEach(() => {
    now = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("counts elapsed time while running", () => {
    const t = new RecordingTimer(clock);
    t.start();
    now = 37_400;
    expect(t.elapsedMs).toBe(37_400);
    expect(t.elapsedSeconds).toBe(37);
  });

  it("excludes paused time", () => {
    const t = new RecordingTimer(clock);
    t.start();
    now = 5_000;
    t.pause();
    now = 65_000; // one paused minute
    expect(t.elapsedSeconds).toBe(5);
    t.resume();
    now = 70_000;
    expect(t.elapsedSeconds).toBe(10);
  });

  it("stop() freezes and returns the final duration", () => {
    const t = new RecordingTimer(clock);
    t.start();
    now = 42_000;
    expect(t.stop()).toBe(42_000);
    now = 99_000;
    expect(t.elapsedMs).toBe(42_000);
    expect(t.running).toBe(false);
  });

  it("fires the limit callback after the requested recorded time", () => {
    const onLimit = vi.fn();
    const t = new RecordingTimer(clock);
    t.start(10_000, onLimit);
    vi.advanceTimersByTime(9_999);
    expect(onLimit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLimit).toHaveBeenCalledOnce();
  });

  it("pausing postpones the limit by the paused time", () => {
    const onLimit = vi.fn();
    const t = new RecordingTimer(clock);
    t.start(10_000, onLimit);

    now = 4_000;
    vi.advanceTimersByTime(4_000);
    t.pause();
    vi.advanceTimersByTime(30_000); // paused: no auto-stop
    expect(onLimit).not.toHaveBeenCalled();

    now = 34_000;
    t.resume(); // 6 s remaining
    vi.advanceTimersByTime(5_999);
    expect(onLimit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLimit).toHaveBeenCalledOnce();
  });

  it("stop() cancels a pending limit", () => {
    const onLimit = vi.fn();
    const t = new RecordingTimer(clock);
    t.start(1_000, onLimit);
    t.stop();
    vi.advanceTimersByTime(5_000);
    expect(onLimit).not.toHaveBeenCalled();
  });
});
