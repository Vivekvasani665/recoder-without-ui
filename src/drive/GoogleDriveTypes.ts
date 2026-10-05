import type { RecorderError } from "../utils/errors";

/** Minimal HTTP abstraction so uploads can use XHR (upload progress) and be tested. */
export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: Blob | string | null;
  signal?: AbortSignal;
  /** Bytes of THIS request's body sent so far. */
  onUploadProgress?: (loadedBytes: number) => void;
}

export interface HttpResponse {
  status: number;
  getHeader(name: string): string | null;
  body: string;
}

/** Must reject (e.g. with TypeError) on network failure and with an AbortError on abort. */
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

/** Result of a token provider: a bare token, or a token with expiry (epoch ms). */
export type AccessTokenResult = string | { accessToken: string; expiresAt?: number };

export interface GoogleDriveConfigInput {
  /**
   * OAuth 2.0 "Web application" client ID from Google Cloud Console
   * (…apps.googleusercontent.com). Client IDs are public; never put a
   * client SECRET in browser code.
   */
  clientId?: string;
  /**
   * Alternative to clientId: supply access tokens yourself (e.g. minted by
   * your backend). Called on connect and again when a token expires.
   */
  tokenProvider?: () => Promise<AccessTokenResult>;
  /** Default upload folder. */
  folderId?: string;
  /** Pre-fill the Google account chooser (email). */
  loginHint?: string;
  /** Resumable chunk size in bytes; multiple of 256 KiB. Default 8 MiB. */
  chunkSize?: number;
  /** Retries per failed request/chunk before giving up. Default 5. */
  maxRetries?: number;
  /** First retry delay; doubles each attempt (with jitter). Default 1000 ms. */
  retryBaseDelayMs?: number;
  /** Advanced: replace the HTTP layer (proxies, tests). Default: XHR. */
  transport?: HttpTransport;
}

export interface DriveAccount {
  name: string | null;
  email: string | null;
  photoUrl: string | null;
}

export interface DriveFolder {
  folderId: string;
  name: string;
}

export interface DriveFile {
  fileId: string;
  fileName: string;
  mimeType: string;
  size: number;
  webViewLink: string | null;
  webContentLink: string | null;
  folderId: string | null;
}

export interface DriveUploadOptions {
  /** Default: recording-YYYY-MM-DD-HH-mm-ss.<ext> */
  fileName?: string;
  /** Overrides the folder set with drive.setFolder(). */
  folderId?: string;
  /** Defaults to the Blob's type. */
  mimeType?: string;
  description?: string;
  signal?: AbortSignal;
  /** Links the upload events to a recording. */
  recordingId?: string;
}

/** Per-recording Drive options, given to startRecording({ drive }) or stopRecording({ drive }). */
export interface RecordingDriveOptions {
  /** Upload automatically when the recording ends (any stop reason). */
  uploadOnStop?: boolean;
  fileName?: string;
  folderId?: string;
  description?: string;
}

export interface DriveUploadProgress {
  uploadId: string;
  recordingId: string | null;
  uploadedBytes: number;
  totalBytes: number;
  percentage: number;
}

export interface DriveEventMap {
  "drive:upload:start": { uploadId: string; recordingId: string | null; fileName: string; totalBytes: number };
  "drive:upload:progress": DriveUploadProgress;
  "drive:upload:complete": { uploadId: string; recordingId: string | null; file: DriveFile };
  "drive:upload:error": { uploadId: string; recordingId: string | null; error: RecorderError };
}

export interface DriveAPI {
  configure(config: GoogleDriveConfigInput): void;
  isConfigured(): boolean;
  connect(): Promise<DriveAccount | null>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getAccount(): DriveAccount | null;
  setFolder(folder: { folderId: string } | null): Promise<DriveFolder | null>;
  getFolder(): string | null;
  createFolder(name: string, options?: { select?: boolean; parentId?: string }): Promise<DriveFolder>;
  upload(blob: Blob, options?: DriveUploadOptions): Promise<DriveFile>;
  makeShareable(fileId: string, options?: { role?: "reader" | "commenter" }): Promise<DriveFile>;
}
