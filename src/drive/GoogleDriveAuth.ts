import { RecorderError } from "../utils/errors";
import { DRIVE_SCOPE, GIS_SCRIPT_URL, type ResolvedDriveConfig } from "./GoogleDriveConfig";
import type { TokenSource } from "./http";

// Minimal typings for Google Identity Services (accounts.google.com/gsi/client).
interface GisTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}
interface GisTokenClient {
  requestAccessToken(overrides?: { prompt?: string; login_hint?: string }): void;
}
interface GisOAuth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    login_hint?: string;
    callback: (resp: GisTokenResponse) => void;
    error_callback?: (err: { type?: string; message?: string }) => void;
  }): GisTokenClient;
  hasGrantedAllScopes(resp: GisTokenResponse, ...scopes: string[]): boolean;
  revoke(token: string, done?: () => void): void;
}
interface GisWindow {
  google?: { accounts?: { oauth2?: GisOAuth2 } };
}

export type GisLoader = () => Promise<GisOAuth2>;

let gisPromise: Promise<GisOAuth2> | null = null;

/** Loads Google Identity Services on demand (a <script> tag; renders nothing). */
export const loadGoogleIdentityServices: GisLoader = () => {
  const existing = (globalThis as GisWindow).google?.accounts?.oauth2;
  if (existing) return Promise.resolve(existing);
  if (gisPromise) return gisPromise;
  gisPromise = new Promise<GisOAuth2>((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new RecorderError("DRIVE_INVALID_CONFIGURATION", "Google sign-in needs a browser (document).", "google-auth"));
      return;
    }
    const script = document.createElement("script");
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      const oauth2 = (globalThis as GisWindow).google?.accounts?.oauth2;
      if (oauth2) resolve(oauth2);
      else reject(new RecorderError("DRIVE_NETWORK_ERROR", "Google Identity Services loaded but is unusable.", "google-auth"));
    };
    script.onerror = () => {
      gisPromise = null;
      reject(new RecorderError("DRIVE_NETWORK_ERROR", "Could not load Google sign-in (accounts.google.com). Check the network / CSP.", "google-auth"));
    };
    document.head.appendChild(script);
  });
  return gisPromise;
};

const EXPIRY_MARGIN_MS = 60_000;

/**
 * OAuth for Drive, exposed as an API (no custom UI). Uses the Google
 * Identity Services token model: connect() opens Google's own consent
 * popup — the Google equivalent of the browser's screen picker.
 *
 * Browser tokens last about an hour and come without a refresh token.
 * Renewal re-asks GIS silently (prompt: ""); if the browser blocks that
 * popup outside a user gesture, GOOGLE_AUTH_EXPIRED is raised. For
 * unattended use, configure a `tokenProvider` backed by your server.
 */
export class GoogleDriveAuth implements TokenSource {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly getConfig: () => ResolvedDriveConfig | null,
    private readonly loadGis: GisLoader = loadGoogleIdentityServices,
    private readonly now: () => number = () => Date.now(),
  ) {}

  isConnected(): boolean {
    return !!this.token && this.token.expiresAt - EXPIRY_MARGIN_MS > this.now();
  }

  /** Interactive sign-in. Call from a click/keypress so the popup isn't blocked. */
  async connect(): Promise<void> {
    this.token = await this.requestToken("interactive");
  }

  /** A valid token: cached, silently renewed, or GOOGLE_AUTH_REQUIRED. */
  async getAccessToken(): Promise<string> {
    if (this.isConnected()) return this.token!.value;
    const config = this.requireConfig();
    if (!this.token && !config.tokenProvider) {
      throw new RecorderError("GOOGLE_AUTH_REQUIRED", "Not connected to Google Drive. Call drive.connect() first.", "google-auth");
    }
    return this.refresh();
  }

  async refresh(): Promise<string> {
    try {
      this.token = await this.requestToken("silent");
      return this.token.value;
    } catch (err) {
      this.token = null;
      if (err instanceof RecorderError && err.code === "DRIVE_INVALID_CONFIGURATION") throw err;
      throw new RecorderError(
        "GOOGLE_AUTH_EXPIRED",
        "Google sign-in expired and could not be renewed automatically. Call drive.connect() again (from a click).",
        "google-auth",
        err,
      );
    }
  }

  async disconnect(): Promise<void> {
    const token = this.token?.value;
    this.token = null;
    const config = this.getConfig();
    if (!token || !config?.clientId || config.tokenProvider) return;
    try {
      const gis = await this.loadGis();
      await new Promise<void>((resolve) => gis.revoke(token, resolve));
    } catch {
      /* best effort */
    }
  }

  private requireConfig(): ResolvedDriveConfig {
    const config = this.getConfig();
    if (!config) {
      throw new RecorderError(
        "DRIVE_INVALID_CONFIGURATION",
        "Google Drive is not configured. Call drive.configure({ clientId }) first.",
        "drive",
      );
    }
    return config;
  }

  private async requestToken(mode: "interactive" | "silent"): Promise<{ value: string; expiresAt: number }> {
    const config = this.requireConfig();

    if (config.tokenProvider) {
      let result;
      try {
        result = await config.tokenProvider();
      } catch (err) {
        throw new RecorderError("GOOGLE_AUTH_REQUIRED", `tokenProvider failed: ${String(err)}`, "google-auth", err);
      }
      const value = typeof result === "string" ? result : result?.accessToken;
      if (!value) throw new RecorderError("GOOGLE_AUTH_REQUIRED", "tokenProvider returned no access token.", "google-auth");
      const expiresAt = typeof result === "object" && result.expiresAt ? result.expiresAt : this.now() + 55 * 60_000;
      return { value, expiresAt };
    }

    const gis = await this.loadGis();
    const resp = await new Promise<GisTokenResponse>((resolve, reject) => {
      const client = gis.initTokenClient({
        client_id: config.clientId!,
        scope: DRIVE_SCOPE,
        login_hint: config.loginHint ?? undefined,
        callback: resolve,
        error_callback: (err) => reject(mapGisError(err.type, err.message)),
      });
      client.requestAccessToken({ prompt: mode === "silent" ? "" : "select_account" });
    });

    if (resp.error || !resp.access_token) throw mapGisError(resp.error, resp.error_description);
    if (!gis.hasGrantedAllScopes(resp, DRIVE_SCOPE)) {
      throw new RecorderError(
        "GOOGLE_PERMISSION_DENIED",
        "Google Drive access was not granted. Tick the Drive permission on the consent screen.",
        "google-auth",
      );
    }
    return { value: resp.access_token, expiresAt: this.now() + Number(resp.expires_in ?? 3600) * 1000 };
  }
}

function mapGisError(type?: string, detail?: string): RecorderError {
  switch (type) {
    case "popup_failed_to_open":
      return new RecorderError(
        "GOOGLE_AUTH_REQUIRED",
        "The Google sign-in popup was blocked. Call drive.connect() from a click or key press.",
        "google-auth",
      );
    case "popup_closed":
    case "access_denied":
      return new RecorderError("GOOGLE_PERMISSION_DENIED", "Google sign-in was cancelled or access was denied.", "google-auth");
    default:
      return new RecorderError("GOOGLE_AUTH_REQUIRED", `Google sign-in failed${type ? ` (${type})` : ""}${detail ? `: ${detail}` : "."}`, "google-auth");
  }
}
