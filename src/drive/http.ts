import { RecorderError, isRecorderError } from "../utils/errors";
import type { HttpRequest, HttpResponse, HttpTransport } from "./GoogleDriveTypes";

/** Default transport: XHR (gives upload progress), falling back to fetch. */
export const defaultTransport: HttpTransport = (req) =>
  typeof XMLHttpRequest !== "undefined" ? xhrTransport(req) : fetchTransport(req);

function xhrTransport(req: HttpRequest): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    if (req.signal?.aborted) return reject(abortError());
    const xhr = new XMLHttpRequest();
    xhr.open(req.method, req.url);
    for (const [k, v] of Object.entries(req.headers ?? {})) xhr.setRequestHeader(k, v);
    if (req.onUploadProgress && xhr.upload) {
      const cb = req.onUploadProgress;
      xhr.upload.onprogress = (e) => cb(e.loaded);
    }
    xhr.onload = () =>
      resolve({ status: xhr.status, getHeader: (n) => xhr.getResponseHeader(n), body: xhr.responseText ?? "" });
    xhr.onerror = () => reject(new TypeError("Network request failed"));
    xhr.ontimeout = () => reject(new TypeError("Network request timed out"));
    xhr.onabort = () => reject(abortError());
    req.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(req.body ?? null);
  });
}

async function fetchTransport(req: HttpRequest): Promise<HttpResponse> {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body ?? undefined, signal: req.signal });
  const body = await res.text();
  req.onUploadProgress?.(req.body instanceof Blob ? req.body.size : 0);
  return { status: res.status, getHeader: (n) => res.headers.get(n), body };
}

function abortError(): Error {
  const e = new Error("The upload was aborted.");
  e.name = "AbortError";
  return e;
}

export const isAbortError = (err: unknown): boolean => (err as { name?: string } | null)?.name === "AbortError";

export interface TokenSource {
  getAccessToken(): Promise<string>;
  /** Called after a 401; must return a fresh token or throw GOOGLE_AUTH_EXPIRED. */
  refresh(): Promise<string>;
}

/** Parsed Google API error. */
export function readApiError(res: HttpResponse): { reason: string; message: string } {
  try {
    const json = JSON.parse(res.body) as { error?: { message?: string; errors?: { reason?: string }[]; status?: string } };
    return {
      reason: json.error?.errors?.[0]?.reason ?? json.error?.status ?? "",
      message: json.error?.message ?? `HTTP ${res.status}`,
    };
  } catch {
    return { reason: "", message: `HTTP ${res.status}` };
  }
}

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "backendError"]);

export function isRetryableResponse(res: HttpResponse): boolean {
  if (res.status === 429 || res.status >= 500) return true;
  return res.status === 403 && RATE_LIMIT_REASONS.has(readApiError(res).reason);
}

/** Map a non-retryable error response to a typed RecorderError. */
export function toDriveError(res: HttpResponse, context: string): RecorderError {
  const { reason, message } = readApiError(res);
  if (res.status === 401) {
    return new RecorderError("GOOGLE_AUTH_EXPIRED", "Google sign-in expired. Call drive.connect() again.", "google-auth");
  }
  if (res.status === 403) {
    if (reason === "storageQuotaExceeded") {
      return new RecorderError("DRIVE_UPLOAD_FAILED", "The user's Google Drive is full.", "drive");
    }
    return new RecorderError(
      "GOOGLE_PERMISSION_DENIED",
      `Google denied access while trying to ${context}: ${message}`,
      "google-auth",
    );
  }
  return new RecorderError("DRIVE_UPLOAD_FAILED", `Failed to ${context}: ${message}`, "drive");
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(abortError());
      },
      { once: true },
    );
  });

export function backoffDelay(attempt: number, baseMs: number): number {
  if (baseMs === 0) return 0;
  const exp = Math.min(baseMs * 2 ** (attempt - 1), 32_000);
  return exp / 2 + Math.random() * (exp / 2);
}

/**
 * Authenticated requests: adds the bearer token, refreshes once on 401,
 * converts network failures to DRIVE_NETWORK_ERROR. Optional retries for
 * idempotent calls.
 */
export class DriveHttp {
  constructor(
    private readonly tokens: TokenSource,
    private readonly transport: () => HttpTransport,
    private readonly retry: { maxRetries: number; baseDelayMs: number },
  ) {}

  async send(req: HttpRequest): Promise<HttpResponse> {
    let token = await this.tokens.getAccessToken();
    let res = await this.raw({ ...req, headers: { ...req.headers, Authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      token = await this.tokens.refresh(); // throws GOOGLE_AUTH_EXPIRED if it can't
      res = await this.raw({ ...req, headers: { ...req.headers, Authorization: `Bearer ${token}` } });
      if (res.status === 401) throw toDriveError(res, "authenticate");
    }
    return res;
  }

  /** send() + retries on network/5xx/429, then JSON. For idempotent calls. */
  async json<T>(req: HttpRequest, context: string, retries = this.retry.maxRetries): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.send(req);
        if (res.status >= 200 && res.status < 300) return (res.body ? JSON.parse(res.body) : {}) as T;
        if (!isRetryableResponse(res) || attempt >= retries) throw toDriveError(res, context);
      } catch (err) {
        if (!isRecorderError(err) || err.code !== "DRIVE_NETWORK_ERROR" || attempt >= retries) throw err;
      }
      await sleep(backoffDelay(attempt + 1, this.retry.baseDelayMs), req.signal);
    }
  }

  private async raw(req: HttpRequest): Promise<HttpResponse> {
    try {
      return await this.transport()(req);
    } catch (err) {
      if (isAbortError(err)) {
        throw new RecorderError("DRIVE_UPLOAD_FAILED", "The upload was aborted.", "drive", err);
      }
      throw new RecorderError("DRIVE_NETWORK_ERROR", "Network error while talking to Google Drive.", "drive", err);
    }
  }
}
