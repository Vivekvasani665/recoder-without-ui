import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GisLoader } from "../src/drive/GoogleDriveAuth";
import { GoogleDriveClient } from "../src/drive/GoogleDriveClient";
import { DRIVE_SCOPE, buildFileName } from "../src/drive/GoogleDriveConfig";
import type { DriveEventMap, GoogleDriveConfigInput } from "../src/drive/GoogleDriveTypes";
import { RecorderError } from "../src/utils/errors";
import { FakeDrive, apiError, isChunkPut, isStatusQuery, networkError } from "./driveFake";

const KiB = 1024;
const CHUNK = 256 * KiB;

function makeBlob(size: number, type = "video/webm"): Blob {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = i % 251;
  return new Blob([data], { type });
}

async function expectCode(p: Promise<unknown>, code: string): Promise<RecorderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(RecorderError);
    expect((err as RecorderError).code).toBe(code);
    return err as RecorderError;
  }
  throw new Error(`expected ${code}`);
}

type Emitted = { [K in keyof DriveEventMap]: [K, DriveEventMap[K]] }[keyof DriveEventMap];

function setup(config: Partial<GoogleDriveConfigInput> = {}) {
  const fake = new FakeDrive();
  const events: Emitted[] = [];
  const tokenProvider = vi.fn(async () => "tok-1");
  const client = new GoogleDriveClient({ emit: (e, p) => events.push([e, p] as Emitted) });
  client.configure({ tokenProvider, transport: fake.transport, chunkSize: CHUNK, retryBaseDelayMs: 0, ...config });
  const ofType = <K extends keyof DriveEventMap>(k: K) =>
    events.filter((e): e is Extract<Emitted, [K, unknown]> => e[0] === k).map((e) => e[1] as DriveEventMap[K]);
  return { fake, client, events, ofType, tokenProvider };
}

describe("configuration", () => {
  it("rejects uploads/connect until configured", async () => {
    const client = new GoogleDriveClient({ emit: () => {} });
    expect(client.isConfigured()).toBe(false);
    await expectCode(client.connect(), "DRIVE_INVALID_CONFIGURATION");
    await expectCode(client.upload(makeBlob(10)), "DRIVE_INVALID_CONFIGURATION");
  });

  it.each([
    [{}, /clientId/],
    [{ clientId: "abc" }, /googleusercontent/],
    [{ clientId: "x.apps.googleusercontent.com", clientSecret: "s" }, /clientSecret/],
    [{ tokenProvider: async () => "t", chunkSize: 1000 }, /256 KiB/],
  ])("rejects invalid config %#", (config, message) => {
    const client = new GoogleDriveClient({ emit: () => {} });
    expect(() => client.configure(config as GoogleDriveConfigInput)).toThrowError(message);
  });

  it("only ever asks for the least-privilege drive.file scope", () => {
    expect(DRIVE_SCOPE).toBe("https://www.googleapis.com/auth/drive.file");
  });
});

describe("authentication (Google Identity Services)", () => {
  function gis(response: Record<string, unknown> | { errorType: string }, granted = true) {
    const requests: { scope: string; prompt?: string }[] = [];
    const oauth2 = {
      initTokenClient: (cfg: { scope: string; callback: (r: unknown) => void; error_callback?: (e: { type: string }) => void }) => ({
        requestAccessToken: (o?: { prompt?: string }) => {
          requests.push({ scope: cfg.scope, prompt: o?.prompt });
          if ("errorType" in response) cfg.error_callback?.({ type: response.errorType as string });
          else cfg.callback(response);
        },
      }),
      hasGrantedAllScopes: () => granted,
      revoke: vi.fn((_t: string, done?: () => void) => done?.()),
    };
    // Structural fake of the GIS API; cast to the loader type it stands in for.
    return { loadGis: (async () => oauth2) as unknown as GisLoader, requests, oauth2 };
  }

  function client(g: ReturnType<typeof gis>, fake = new FakeDrive()) {
    const c = new GoogleDriveClient({ emit: () => {}, loadGis: g.loadGis, transport: fake.transport });
    c.configure({ clientId: "123.apps.googleusercontent.com", retryBaseDelayMs: 0 });
    return c;
  }

  it("connect() → isConnected() true and account info", async () => {
    const g = gis({ access_token: "tok-1", expires_in: 3600, scope: DRIVE_SCOPE });
    const c = client(g);
    expect(c.isConnected()).toBe(false);
    const account = await c.connect();
    expect(c.isConnected()).toBe(true);
    expect(account).toEqual({ name: "Test User", email: "test@example.com", photoUrl: "https://p/1" });
    expect(c.getAccount()?.email).toBe("test@example.com");
    expect(g.requests[0]).toEqual({ scope: DRIVE_SCOPE, prompt: "select_account" });
  });

  it("disconnect() revokes and clears", async () => {
    const g = gis({ access_token: "tok-1", expires_in: 3600 });
    const c = client(g);
    await c.connect();
    await c.disconnect();
    expect(c.isConnected()).toBe(false);
    expect(c.getAccount()).toBeNull();
    expect(g.oauth2.revoke).toHaveBeenCalledWith("tok-1", expect.any(Function));
  });

  it("closing the consent popup → GOOGLE_PERMISSION_DENIED", async () => {
    await expectCode(client(gis({ errorType: "popup_closed" })).connect(), "GOOGLE_PERMISSION_DENIED");
  });

  it("Drive scope not granted → GOOGLE_PERMISSION_DENIED", async () => {
    await expectCode(client(gis({ access_token: "tok-1" }, false)).connect(), "GOOGLE_PERMISSION_DENIED");
  });

  it("blocked popup → GOOGLE_AUTH_REQUIRED with a hint", async () => {
    const err = await expectCode(client(gis({ errorType: "popup_failed_to_open" })).connect(), "GOOGLE_AUTH_REQUIRED");
    expect(err.message).toMatch(/click/);
  });

  it("upload before connect() → GOOGLE_AUTH_REQUIRED", async () => {
    await expectCode(client(gis({ access_token: "tok-1" })).upload(makeBlob(10)), "GOOGLE_AUTH_REQUIRED");
  });
});

describe("resumable upload", () => {
  it("uploads in 256 KiB-multiple chunks with progress and returns links", async () => {
    const { fake, client, ofType } = setup();
    const blob = makeBlob(600 * KiB);

    const file = await client.upload(blob, { fileName: "client-demo-recording.webm" });

    const puts = fake.requests.filter(isChunkPut);
    expect(puts.map((r) => r.headers?.["Content-Range"])).toEqual([
      `bytes 0-${CHUNK - 1}/${blob.size}`,
      `bytes ${CHUNK}-${2 * CHUNK - 1}/${blob.size}`,
      `bytes ${2 * CHUNK}-${blob.size - 1}/${blob.size}`,
    ]);
    expect(file).toMatchObject({
      fileName: "client-demo-recording.webm",
      mimeType: "video/webm",
      size: blob.size,
      webViewLink: expect.stringContaining("/view"),
      webContentLink: expect.stringContaining("export=download"),
    });
    expect(fake.files.get(file.fileId)!.data).toEqual(new Uint8Array(await blob.arrayBuffer()));

    const progress = ofType("drive:upload:progress");
    expect(progress[0].percentage).toBe(0);
    expect(progress.at(-1)).toMatchObject({ uploadedBytes: blob.size, totalBytes: blob.size, percentage: 100 });
    const pcts = progress.map((p) => p.uploadedBytes);
    expect([...pcts].sort((a, b) => a - b)).toEqual(pcts); // monotonic
    expect(ofType("drive:upload:start")[0]).toMatchObject({ fileName: "client-demo-recording.webm", totalBytes: blob.size });
    expect(ofType("drive:upload:complete")[0].file).toEqual(file);
  });

  it("names files recording-YYYY-MM-DD-HH-mm-ss.<ext> by default", async () => {
    const { client } = setup();
    const file = await client.upload(makeBlob(10));
    expect(file.fileName).toMatch(/^recording-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.webm$/);
    expect(buildFileName("video/mp4", undefined, new Date(2026, 9, 5, 16, 30, 45))).toBe("recording-2026-10-05-16-30-45.mp4");
    expect(buildFileName("video/webm", "client-demo")).toBe("client-demo.webm");
  });

  it("never makes the file public on its own", async () => {
    const { fake, client } = setup();
    const file = await client.upload(makeBlob(10));
    expect(fake.files.get(file.fileId)!.permissions).toEqual([]);
    expect(fake.requests.some((r) => r.url.includes("/permissions"))).toBe(false);
  });

  it("resumes from the server's offset after a network interruption", async () => {
    const { fake, client } = setup();
    const blob = makeBlob(600 * KiB);
    fake.failOnce((r) => isChunkPut(r) && (r.headers?.["Content-Range"] ?? "").startsWith(`bytes ${CHUNK}-`), networkError());

    const file = await client.upload(blob);

    expect(fake.requests.filter(isStatusQuery)).toHaveLength(1);
    expect(fake.files.get(file.fileId)!.data).toEqual(new Uint8Array(await blob.arrayBuffer()));
  });

  it("retries a failed chunk on 503 / 429", async () => {
    const { fake, client } = setup();
    fake.failOnce(isChunkPut, apiError(503, "backendError"));
    fake.failOnce(isChunkPut, apiError(429, "rateLimitExceeded"));
    const file = await client.upload(makeBlob(300 * KiB));
    expect(file.size).toBe(300 * KiB);
  });

  it("starts a new session when the upload session expired", async () => {
    const { fake, client } = setup();
    const blob = makeBlob(600 * KiB);
    let puts = 0;
    fake.faults.push((r) => {
      if (isChunkPut(r) && ++puts === 2) fake.sessions.forEach((s) => (s.expired = true));
      return undefined;
    });
    const file = await client.upload(blob);
    expect(fake.sessions.size).toBe(2);
    expect(fake.files.get(file.fileId)!.data).toEqual(new Uint8Array(await blob.arrayBuffer()));
  });

  it("refreshes an expired token mid-upload and continues", async () => {
    const { fake, client, tokenProvider } = setup();
    tokenProvider.mockResolvedValueOnce("tok-1").mockResolvedValueOnce("tok-2");
    fake.failOnce((r) => isChunkPut(r) && (r.headers?.["Content-Range"] ?? "").startsWith(`bytes ${CHUNK}-`), apiError(401, "authError"));
    const file = await client.upload(makeBlob(600 * KiB));
    expect(file.size).toBe(600 * KiB);
    expect(fake.requests.at(-1)!.headers!.Authorization).toBe("Bearer tok-2");
  });

  it("GOOGLE_AUTH_EXPIRED when the token can't be renewed", async () => {
    const { fake, client, tokenProvider, ofType } = setup();
    fake.validTokens = new Set(["tok-1"]);
    tokenProvider.mockResolvedValueOnce("tok-1").mockRejectedValue(new Error("session over"));
    fake.failOnce(isChunkPut, apiError(401, "authError"));
    await expectCode(client.upload(makeBlob(10)), "GOOGLE_AUTH_EXPIRED");
    expect(ofType("drive:upload:error")[0].error.code).toBe("GOOGLE_AUTH_EXPIRED");
  });

  it("DRIVE_NETWORK_ERROR after retries are exhausted", async () => {
    const { fake, client } = setup({ maxRetries: 2 });
    fake.faults.push((r) => (r.method === "PUT" ? networkError() : undefined));
    await expectCode(client.upload(makeBlob(10)), "DRIVE_NETWORK_ERROR");
  });

  it("GOOGLE_PERMISSION_DENIED on 403 insufficientPermissions", async () => {
    const { fake, client } = setup();
    fake.failOnce((r) => r.method === "POST", apiError(403, "insufficientPermissions"));
    await expectCode(client.upload(makeBlob(10)), "GOOGLE_PERMISSION_DENIED");
  });

  it("can be aborted", async () => {
    const { client } = setup();
    const ctrl = new AbortController();
    ctrl.abort();
    await expectCode(client.upload(makeBlob(10), { signal: ctrl.signal }), "DRIVE_UPLOAD_FAILED");
  });
});

describe("folders", () => {
  it("uploads into the configured folder", async () => {
    const { fake, client } = setup();
    expect(await client.setFolder({ folderId: "folder-1" })).toEqual({ folderId: "folder-1", name: "Recordings" });
    const file = await client.upload(makeBlob(10));
    expect(file.folderId).toBe("folder-1");
    expect(fake.files.get(file.fileId)!.parents).toEqual(["folder-1"]);
  });

  it("uploads to My Drive when no folder is set", async () => {
    const { fake, client } = setup();
    const file = await client.upload(makeBlob(10));
    const start = fake.requests.find((r) => r.method === "POST")!;
    expect(JSON.parse(String(start.body)).parents).toBeUndefined();
    expect(file.folderId).toBe("root");
  });

  it.each(["missing-folder", "doc-1"])("DRIVE_FOLDER_NOT_FOUND for %s", async (folderId) => {
    const { client } = setup();
    await expectCode(client.setFolder({ folderId }), "DRIVE_FOLDER_NOT_FOUND");
  });

  it("createFolder({ select: true }) uses the new folder", async () => {
    const { fake, client } = setup();
    const folder = await client.createFolder("Screen recordings", { select: true });
    expect(client.getFolder()).toBe(folder.folderId);
    const file = await client.upload(makeBlob(10));
    expect(fake.files.get(file.fileId)!.parents).toEqual([folder.folderId]);
  });
});

describe("makeShareable()", () => {
  it("is explicit and grants anyone-with-link reader access", async () => {
    const { fake, client } = setup();
    const file = await client.upload(makeBlob(10));
    const shared = await client.makeShareable(file.fileId);
    expect(fake.files.get(file.fileId)!.permissions).toEqual([{ type: "anyone", role: "reader" }]);
    expect(shared.webViewLink).toContain(file.fileId);
  });
});

afterEach(() => vi.restoreAllMocks());
beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
