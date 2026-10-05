import type { RecordingResult, RecordingSession, RecordingStatus } from "../api/types";
import type { DriveEventMap } from "../drive/GoogleDriveTypes";
import type { RecorderError } from "../utils/errors";

export interface RecorderEventMap extends DriveEventMap {
  "recording:start": RecordingSession;
  "recording:stop": RecordingResult;
  "recording:pause": RecordingStatus;
  "recording:resume": RecordingStatus;
  "recording:error": RecorderError;
  "recording:data": { id: string; chunk: Blob; size: number; totalChunks: number; totalSize: number };
  /** The user clicked the browser's native "Stop sharing". Finalization follows with `recording:stop`. */
  "recording:screen-ended": RecordingStatus;
}

export type RecorderEventName = keyof RecorderEventMap;
export type RecorderEventHandler<K extends RecorderEventName> = (payload: RecorderEventMap[K]) => void;

/** Small typed emitter; no DOM dependency. */
export class RecorderEvents {
  // Handlers are stored type-erased; the public methods keep them typed per event.
  private readonly handlers = new Map<RecorderEventName, Set<(payload: never) => void>>();

  on<K extends RecorderEventName>(event: K, handler: RecorderEventHandler<K>): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler);
    return () => this.off(event, handler);
  }

  once<K extends RecorderEventName>(event: K, handler: RecorderEventHandler<K>): () => void {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off<K extends RecorderEventName>(event: K, handler: RecorderEventHandler<K>): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit<K extends RecorderEventName>(event: K, payload: RecorderEventMap[K]): void {
    const set = this.handlers.get(event) as Set<RecorderEventHandler<K>> | undefined;
    for (const handler of [...(set ?? [])]) {
      try {
        handler(payload);
      } catch (err) {
        // A faulty listener must never break the recorder.
        console.error(`[screen-recorder] "${event}" listener threw`, err);
      }
    }
  }

  removeAll(): void {
    this.handlers.clear();
  }
}
