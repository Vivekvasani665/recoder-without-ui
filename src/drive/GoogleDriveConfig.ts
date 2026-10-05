import { RecorderError } from "../utils/errors";
import type { GoogleDriveConfigInput, HttpTransport } from "./GoogleDriveTypes";

/**
 * Least-privilege scope: the app can only see and manage files it created
 * (or that the user explicitly opened with it). It cannot read the rest of
 * the user's Drive. Full "auth/drive" is never requested.
 */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
export const GIS_SCRIPT_URL = "https://accounts.google.com/gsi/client";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const FILE_FIELDS = "id,name,mimeType,size,webViewLink,webContentLink,parents";

const CHUNK_UNIT = 256 * 1024; // Drive requires chunk sizes in multiples of 256 KiB

export interface ResolvedDriveConfig {
  clientId: string | null;
  tokenProvider: GoogleDriveConfigInput["tokenProvider"] | null;
  folderId: string | null;
  loginHint: string | null;
  chunkSize: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  transport: HttpTransport | null;
}

export function resolveDriveConfig(input: GoogleDriveConfigInput): ResolvedDriveConfig {
  const invalid = (message: string) => new RecorderError("DRIVE_INVALID_CONFIGURATION", message, "drive");

  for (const secret of ["clientSecret", "client_secret", "apiSecret"]) {
    if (secret in (input as object)) {
      throw invalid(`Do not put "${secret}" in browser code. A browser OAuth flow only needs the public clientId.`);
    }
  }
  if (!input.clientId && !input.tokenProvider) {
    throw invalid("Google Drive needs a `clientId` (OAuth Web client ID) or a `tokenProvider`.");
  }
  if (input.clientId && !/\.apps\.googleusercontent\.com$/.test(input.clientId)) {
    throw invalid("`clientId` must be an OAuth client ID ending in .apps.googleusercontent.com.");
  }
  if (input.tokenProvider && typeof input.tokenProvider !== "function") {
    throw invalid("`tokenProvider` must be a function returning an access token.");
  }

  const chunkSize = input.chunkSize ?? 8 * 1024 * 1024;
  if (!Number.isInteger(chunkSize) || chunkSize < CHUNK_UNIT || chunkSize % CHUNK_UNIT !== 0) {
    throw invalid(`\`chunkSize\` must be a positive multiple of ${CHUNK_UNIT} bytes (256 KiB).`);
  }
  const maxRetries = input.maxRetries ?? 5;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw invalid("`maxRetries` must be a non-negative integer.");
  const retryBaseDelayMs = input.retryBaseDelayMs ?? 1000;
  if (!(retryBaseDelayMs >= 0)) throw invalid("`retryBaseDelayMs` must be >= 0.");

  return {
    clientId: input.clientId ?? null,
    tokenProvider: input.tokenProvider ?? null,
    folderId: input.folderId ?? null,
    loginHint: input.loginHint ?? null,
    chunkSize,
    maxRetries,
    retryBaseDelayMs,
    transport: input.transport ?? null,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function extensionForMime(mimeType: string): string {
  return mimeType.includes("mp4") ? "mp4" : "webm";
}

/** recording-YYYY-MM-DD-HH-mm-ss.<ext> (local time), or the custom name (extension added if missing). */
export function buildFileName(mimeType: string, custom?: string, date: Date = new Date()): string {
  const ext = extensionForMime(mimeType);
  if (custom && custom.trim()) {
    const name = custom.trim();
    return /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}.${ext}`;
  }
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `recording-${stamp}.${ext}`;
}
