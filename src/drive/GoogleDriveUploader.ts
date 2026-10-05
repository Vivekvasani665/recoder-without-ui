import { RecorderError, isRecorderError } from "../utils/errors";
import { DRIVE_UPLOAD_API, FILE_FIELDS, type ResolvedDriveConfig } from "./GoogleDriveConfig";
import { DriveHttp, backoffDelay, isRetryableResponse, sleep, toDriveError } from "./http";
import type { HttpResponse } from "./GoogleDriveTypes";

export interface DriveFileResource {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  webViewLink?: string;
  webContentLink?: string;
  parents?: string[];
}

export interface ResumableUploadRequest {
  blob: Blob;
  fileName: string;
  mimeType: string;
  folderId: string | null;
  description?: string;
  signal?: AbortSignal;
  onProgress(uploadedBytes: number): void;
}

/** Max times a whole upload restarts from byte 0 after its session expired. */
const MAX_SESSION_RESTARTS = 2;

/**
 * Google Drive resumable upload:
 *
 *   POST  /upload/drive/v3/files?uploadType=resumable   → session URL (Location)
 *   PUT   session  Content-Range: bytes a-b/total        → 308 + Range (continue) | 200/201 (done)
 *
 * Recovery:
 *   network error / 5xx / 429  → back off, ask the session how much it has
 *                                (PUT Content-Range: bytes * /total), resume there
 *   401                        → token refreshed once by DriveHttp, chunk resent
 *   404 / 410 on the session   → session expired: start a new one from 0
 */
export class GoogleDriveUploader {
  constructor(
    private readonly http: DriveHttp,
    private readonly config: () => ResolvedDriveConfig,
  ) {}

  async upload(req: ResumableUploadRequest): Promise<DriveFileResource> {
    const { blob, signal } = req;
    const total = blob.size;
    const { chunkSize, maxRetries, retryBaseDelayMs } = this.config();

    let session = await this.createSession(req);
    let offset = 0;
    let failures = 0;
    let restarts = 0;
    req.onProgress(0);

    for (;;) {
      throwIfAborted(signal);
      const end = Math.min(offset + chunkSize, total);
      let outcome: Outcome;
      try {
        const res = await this.http.send({
          method: "PUT",
          url: session,
          headers: { "Content-Range": total === 0 ? "bytes */0" : `bytes ${offset}-${end - 1}/${total}` },
          body: total === 0 ? null : blob.slice(offset, end),
          signal,
          onUploadProgress: (loaded) => req.onProgress(Math.min(total, offset + loaded)),
        });
        outcome = classify(res);
      } catch (err) {
        outcome = asRetryableNetwork(err);
      }

      switch (outcome.kind) {
        case "done":
          req.onProgress(total);
          return outcome.file;
        case "continue":
          offset = outcome.nextOffset;
          failures = 0;
          req.onProgress(offset);
          continue;
        case "expired":
          if (restarts++ >= MAX_SESSION_RESTARTS) {
            throw new RecorderError("DRIVE_UPLOAD_FAILED", "The Drive upload session kept expiring.", "drive");
          }
          session = await this.createSession(req);
          offset = 0;
          failures = 0;
          req.onProgress(0);
          continue;
        case "fatal":
          throw outcome.error;
        case "retry": {
          if (++failures > maxRetries) throw outcome.error;
          await sleep(backoffDelay(failures, retryBaseDelayMs), signal).catch((err: unknown) => {
            throw new RecorderError("DRIVE_UPLOAD_FAILED", "The upload was aborted.", "drive", err);
          });
          // Ask the server what it actually received, then resume from there.
          const status = await this.queryStatus(session, total, signal);
          if (status.kind === "done") {
            req.onProgress(total);
            return status.file;
          }
          if (status.kind === "continue") offset = status.nextOffset;
          if (status.kind === "expired") {
            if (restarts++ >= MAX_SESSION_RESTARTS) {
              throw new RecorderError("DRIVE_UPLOAD_FAILED", "The Drive upload session kept expiring.", "drive");
            }
            session = await this.createSession(req);
            offset = 0;
          }
          if (status.kind === "fatal") throw status.error;
          // "retry" from the status query: keep the current offset and try the chunk again.
          req.onProgress(offset);
          continue;
        }
      }
    }
  }

  private async createSession(req: ResumableUploadRequest): Promise<string> {
    const { maxRetries, retryBaseDelayMs } = this.config();
    const metadata: Record<string, unknown> = { name: req.fileName, mimeType: req.mimeType };
    if (req.folderId) metadata.parents = [req.folderId];
    if (req.description) metadata.description = req.description;

    for (let attempt = 0; ; attempt++) {
      throwIfAborted(req.signal);
      let res: HttpResponse;
      try {
        res = await this.http.send({
          method: "POST",
          url: `${DRIVE_UPLOAD_API}/files?uploadType=resumable&supportsAllDrives=true&fields=${FILE_FIELDS}`,
          headers: {
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": req.mimeType,
            "X-Upload-Content-Length": String(req.blob.size),
          },
          body: JSON.stringify(metadata),
          signal: req.signal,
        });
      } catch (err) {
        if (!(isRecorderError(err) && err.code === "DRIVE_NETWORK_ERROR") || attempt >= maxRetries) throw err;
        await sleep(backoffDelay(attempt + 1, retryBaseDelayMs), req.signal);
        continue;
      }

      if (res.status >= 200 && res.status < 300) {
        const location = res.getHeader("Location") ?? res.getHeader("location");
        if (!location) {
          throw new RecorderError("DRIVE_UPLOAD_FAILED", "Drive did not return an upload session URL.", "drive");
        }
        return location;
      }
      if (res.status === 404 && req.folderId) {
        throw new RecorderError(
          "DRIVE_FOLDER_NOT_FOUND",
          `Drive folder "${req.folderId}" was not found or this app can't access it. With the drive.file scope the folder must be created by this app (drive.createFolder).`,
          "drive",
        );
      }
      if (!isRetryableResponse(res) || attempt >= maxRetries) throw toDriveError(res, "start the Drive upload");
      await sleep(backoffDelay(attempt + 1, retryBaseDelayMs), req.signal);
    }
  }

  private async queryStatus(session: string, total: number, signal?: AbortSignal): Promise<Outcome> {
    try {
      const res = await this.http.send({
        method: "PUT",
        url: session,
        headers: { "Content-Range": `bytes */${total}` },
        body: null,
        signal,
      });
      return classify(res);
    } catch (err) {
      return asRetryableNetwork(err);
    }
  }
}

type Outcome =
  | { kind: "done"; file: DriveFileResource }
  | { kind: "continue"; nextOffset: number }
  | { kind: "expired" }
  | { kind: "retry"; error: RecorderError }
  | { kind: "fatal"; error: RecorderError };

function classify(res: HttpResponse): Outcome {
  if (res.status === 200 || res.status === 201) {
    try {
      return { kind: "done", file: JSON.parse(res.body) as DriveFileResource };
    } catch {
      return { kind: "fatal", error: new RecorderError("DRIVE_UPLOAD_FAILED", "Drive returned an unreadable response.", "drive") };
    }
  }
  if (res.status === 308) {
    // "Range: bytes=0-12345" → next byte is 12346. No Range → nothing stored yet.
    const range = res.getHeader("Range") ?? res.getHeader("range");
    const match = range ? /bytes=\d+-(\d+)/.exec(range) : null;
    return { kind: "continue", nextOffset: match ? Number(match[1]) + 1 : 0 };
  }
  if (res.status === 404 || res.status === 410) return { kind: "expired" };
  if (isRetryableResponse(res)) return { kind: "retry", error: toDriveError(res, "upload to Drive") };
  return { kind: "fatal", error: toDriveError(res, "upload to Drive") };
}

function asRetryableNetwork(err: unknown): Outcome {
  if (isRecorderError(err) && err.code === "DRIVE_NETWORK_ERROR") return { kind: "retry", error: err };
  return {
    kind: "fatal",
    error: isRecorderError(err) ? err : new RecorderError("DRIVE_UPLOAD_FAILED", String(err), "drive", err),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RecorderError("DRIVE_UPLOAD_FAILED", "The upload was aborted.", "drive");
}
