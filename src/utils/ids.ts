/** Unique recording id. Uses crypto.randomUUID when available. */
export function createRecordingId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
