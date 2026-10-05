import { createRecordingId } from "../utils/ids";
import { RecorderError, isRecorderError } from "../utils/errors";
import { GoogleDriveAuth, loadGoogleIdentityServices, type GisLoader } from "./GoogleDriveAuth";
import {
  DRIVE_API,
  FILE_FIELDS,
  FOLDER_MIME,
  buildFileName,
  resolveDriveConfig,
  type ResolvedDriveConfig,
} from "./GoogleDriveConfig";
import { GoogleDriveUploader, type DriveFileResource } from "./GoogleDriveUploader";
import { DriveHttp, defaultTransport, toDriveError } from "./http";
import type {
  DriveAPI,
  DriveAccount,
  DriveEventMap,
  DriveFile,
  DriveFolder,
  DriveUploadOptions,
  GoogleDriveConfigInput,
  HttpTransport,
} from "./GoogleDriveTypes";

export interface GoogleDriveClientDeps {
  emit<K extends keyof DriveEventMap>(event: K, payload: DriveEventMap[K]): void;
  transport?: HttpTransport;
  loadGis?: GisLoader;
}

/**
 * Headless Google Drive integration (ScreenRecorder.drive). Completely
 * independent of the recorder: it only uploads Blobs. Nothing here runs —
 * and no Google script is loaded — until you call it.
 */
export class GoogleDriveClient implements DriveAPI {
  private config: ResolvedDriveConfig | null = null;
  private readonly auth: GoogleDriveAuth;
  private readonly http: DriveHttp;
  private readonly uploader: GoogleDriveUploader;
  private account: DriveAccount | null = null;
  private folderId: string | null = null;
  private folderVerified = false;

  constructor(private readonly deps: GoogleDriveClientDeps) {
    this.auth = new GoogleDriveAuth(() => this.config, deps.loadGis ?? loadGoogleIdentityServices);
    const self = this;
    this.http = new DriveHttp(this.auth, () => this.config?.transport ?? deps.transport ?? defaultTransport, {
      get maxRetries() {
        return self.config?.maxRetries ?? 5;
      },
      get baseDelayMs() {
        return self.config?.retryBaseDelayMs ?? 1000;
      },
    });
    this.uploader = new GoogleDriveUploader(this.http, () => this.requireConfig());
  }

  configure(input: GoogleDriveConfigInput): void {
    this.config = resolveDriveConfig(input);
    if (input.folderId !== undefined) {
      this.folderId = input.folderId || null;
      this.folderVerified = false;
    }
  }

  isConfigured(): boolean {
    return this.config !== null;
  }

  /** Opens Google's consent popup (call from a user gesture). Resolves with the account. */
  async connect(): Promise<DriveAccount | null> {
    this.requireConfig();
    await this.auth.connect();
    this.account = await this.fetchAccount();
    if (this.folderId && !this.folderVerified) await this.verifyFolder(this.folderId);
    return this.account;
  }

  async disconnect(): Promise<void> {
    await this.auth.disconnect();
    this.account = null;
  }

  isConnected(): boolean {
    return this.auth.isConnected();
  }

  getAccount(): DriveAccount | null {
    return this.isConnected() ? this.account : null;
  }

  /**
   * Upload destination for future uploads. Verified immediately when
   * connected, otherwise on the next upload. `null` = Drive root ("My Drive").
   */
  async setFolder(folder: { folderId: string } | null): Promise<DriveFolder | null> {
    this.folderId = folder?.folderId || null;
    this.folderVerified = false;
    if (!this.folderId) return null;
    if (!this.isConnected() && !this.config?.tokenProvider) return { folderId: this.folderId, name: "" };
    return this.verifyFolder(this.folderId);
  }

  getFolder(): string | null {
    return this.folderId;
  }

  /** Create a folder (visible to this app under drive.file) and optionally use it for uploads. */
  async createFolder(name: string, options: { select?: boolean; parentId?: string } = {}): Promise<DriveFolder> {
    this.requireConfig();
    const res = await this.http.send({
      method: "POST",
      url: `${DRIVE_API}/files?supportsAllDrives=true&fields=id,name`,
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(options.parentId ? { parents: [options.parentId] } : {}) }),
    });
    if (res.status < 200 || res.status >= 300) throw toDriveError(res, "create the Drive folder");
    const json = JSON.parse(res.body) as { id: string; name: string };
    const folder = { folderId: json.id, name: json.name };
    if (options.select) {
      this.folderId = folder.folderId;
      this.folderVerified = true;
    }
    return folder;
  }

  /**
   * Resumable upload with progress events. The file keeps the user's
   * default (private) Drive permissions — see makeShareable().
   */
  async upload(blob: Blob, options: DriveUploadOptions = {}): Promise<DriveFile> {
    const uploadId = createRecordingId();
    const recordingId = options.recordingId ?? null;
    const mimeType = options.mimeType || blob.type || "video/webm";
    const fileName = buildFileName(mimeType, options.fileName);
    const folderId = options.folderId ?? this.folderId;
    const totalBytes = blob.size;

    try {
      this.requireConfig();
      await this.auth.getAccessToken(); // GOOGLE_AUTH_REQUIRED before any event if not connected
      if (folderId && (folderId !== this.folderId || !this.folderVerified)) await this.verifyFolder(folderId);

      this.deps.emit("drive:upload:start", { uploadId, recordingId, fileName, totalBytes });
      let last = -1;
      const resource = await this.uploader.upload({
        blob,
        fileName,
        mimeType,
        folderId,
        description: options.description,
        signal: options.signal,
        onProgress: (uploadedBytes) => {
          const percentage = totalBytes === 0 ? 100 : Math.floor((uploadedBytes / totalBytes) * 100);
          if (uploadedBytes === last) return;
          last = uploadedBytes;
          this.deps.emit("drive:upload:progress", { uploadId, recordingId, uploadedBytes, totalBytes, percentage });
        },
      });
      const file = toDriveFile(resource, folderId);
      this.deps.emit("drive:upload:complete", { uploadId, recordingId, file });
      return file;
    } catch (err) {
      const error = isRecorderError(err)
        ? err
        : new RecorderError("DRIVE_UPLOAD_FAILED", `Drive upload failed: ${String(err)}`, "drive", err);
      this.deps.emit("drive:upload:error", { uploadId, recordingId, error });
      throw error;
    }
  }

  /**
   * EXPLICIT opt-in: lets anyone with the link view the file. Never called
   * automatically.
   */
  async makeShareable(fileId: string, options: { role?: "reader" | "commenter" } = {}): Promise<DriveFile> {
    this.requireConfig();
    if (!fileId) throw new RecorderError("DRIVE_INVALID_CONFIGURATION", "makeShareable() needs a fileId.", "drive");
    const res = await this.http.send({
      method: "POST",
      url: `${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions?supportsAllDrives=true`,
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ type: "anyone", role: options.role ?? "reader" }),
    });
    if (res.status < 200 || res.status >= 300) throw toDriveError(res, "share the Drive file");
    const resource = await this.http.json<DriveFileResource>(
      { method: "GET", url: `${DRIVE_API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=${FILE_FIELDS}` },
      "read the Drive file",
    );
    return toDriveFile(resource, resource.parents?.[0] ?? null);
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private requireConfig(): ResolvedDriveConfig {
    if (!this.config) {
      throw new RecorderError(
        "DRIVE_INVALID_CONFIGURATION",
        "Google Drive is not configured. Call ScreenRecorder.drive.configure({ clientId }) first.",
        "drive",
      );
    }
    return this.config;
  }

  private async verifyFolder(folderId: string): Promise<DriveFolder> {
    let meta: { id: string; name: string; mimeType: string; trashed?: boolean };
    try {
      meta = await this.http.json(
        {
          method: "GET",
          url: `${DRIVE_API}/files/${encodeURIComponent(folderId)}?supportsAllDrives=true&fields=id,name,mimeType,trashed`,
        },
        "read the Drive folder",
      );
    } catch (err) {
      if (isRecorderError(err) && (err.code === "DRIVE_UPLOAD_FAILED" || err.code === "GOOGLE_PERMISSION_DENIED")) {
        throw folderNotFound(folderId, err);
      }
      throw err;
    }
    if (meta.mimeType !== FOLDER_MIME || meta.trashed) throw folderNotFound(folderId);
    if (folderId === this.folderId) this.folderVerified = true;
    return { folderId: meta.id, name: meta.name };
  }

  private async fetchAccount(): Promise<DriveAccount | null> {
    try {
      const about = await this.http.json<{ user?: { displayName?: string; emailAddress?: string; photoLink?: string } }>(
        { method: "GET", url: `${DRIVE_API}/about?fields=user(displayName,emailAddress,photoLink)` },
        "read the Google account",
        1,
      );
      return {
        name: about.user?.displayName ?? null,
        email: about.user?.emailAddress ?? null,
        photoUrl: about.user?.photoLink ?? null,
      };
    } catch {
      return null; // account info is nice-to-have; uploads still work
    }
  }
}

function folderNotFound(folderId: string, cause?: unknown): RecorderError {
  return new RecorderError(
    "DRIVE_FOLDER_NOT_FOUND",
    `Drive folder "${folderId}" was not found, is not a folder, or this app can't access it. With the least-privilege drive.file scope, use a folder created by this app (drive.createFolder).`,
    "drive",
    cause,
  );
}

function toDriveFile(r: DriveFileResource, folderId: string | null): DriveFile {
  return {
    fileId: r.id,
    fileName: r.name,
    mimeType: r.mimeType,
    size: Number(r.size ?? 0),
    webViewLink: r.webViewLink ?? null,
    webContentLink: r.webContentLink ?? null,
    folderId: r.parents?.[0] ?? folderId,
  };
}
