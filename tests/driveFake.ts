/**
 * In-memory fake of the Google Drive v3 endpoints the recorder uses,
 * exposed as an HttpTransport. Supports fault injection per request.
 */
import type { HttpRequest, HttpResponse, HttpTransport } from "../src/drive/GoogleDriveTypes";

interface Session {
  metadata: { name: string; mimeType: string; parents?: string[]; description?: string };
  total: number;
  received: Uint8Array;
  receivedBytes: number;
  expired: boolean;
}

export type Fault = (req: HttpRequest) => HttpResponse | Error | undefined;

const res = (status: number, body: unknown = "", headers: Record<string, string> = {}): HttpResponse => ({
  status,
  getHeader: (n) => headers[n] ?? headers[n.toLowerCase()] ?? null,
  body: typeof body === "string" ? body : JSON.stringify(body),
});

export const apiError = (status: number, reason = "", message = "error") =>
  res(status, { error: { message, errors: [{ reason }] } });

export class FakeDrive {
  sessions = new Map<string, Session>();
  files = new Map<string, { id: string; name: string; mimeType: string; parents?: string[]; data?: Uint8Array; permissions: unknown[] }>();
  requests: HttpRequest[] = [];
  faults: Fault[] = [];
  validTokens = new Set(["tok-1", "tok-2", "tok-3"]);
  private seq = 0;

  constructor() {
    this.files.set("folder-1", { id: "folder-1", name: "Recordings", mimeType: "application/vnd.google-apps.folder", permissions: [] });
    this.files.set("doc-1", { id: "doc-1", name: "notes", mimeType: "text/plain", permissions: [] });
  }

  /** Queue a one-shot fault for the next request matching `match`. */
  failOnce(match: (req: HttpRequest) => boolean, result: HttpResponse | Error): void {
    let used = false;
    this.faults.push((req) => {
      if (used || !match(req)) return undefined;
      used = true;
      return result;
    });
  }

  get chunkPuts(): HttpRequest[] {
    return this.requests.filter((r) => r.method === "PUT" && !/\*\//.test(r.headers?.["Content-Range"] ?? ""));
  }

  transport: HttpTransport = async (req) => {
    this.requests.push(req);
    for (const fault of this.faults) {
      const out = fault(req);
      if (out instanceof Error) throw out;
      if (out) return out;
    }
    const auth = req.headers?.Authorization?.replace("Bearer ", "");
    if (!auth || !this.validTokens.has(auth)) return apiError(401, "authError", "Invalid Credentials");

    const url = new URL(req.url);

    // Start resumable session
    if (req.method === "POST" && url.pathname === "/upload/drive/v3/files") {
      const metadata = JSON.parse(String(req.body));
      const parent = metadata.parents?.[0];
      if (parent && !this.files.has(parent)) return apiError(404, "notFound", "File not found");
      const id = `s${++this.seq}`;
      this.sessions.set(id, {
        metadata,
        total: Number(req.headers?.["X-Upload-Content-Length"]),
        received: new Uint8Array(Number(req.headers?.["X-Upload-Content-Length"])),
        receivedBytes: 0,
        expired: false,
      });
      return res(200, "", { Location: `https://upload.test/session/${id}` });
    }

    // Session PUT (chunk or status query)
    if (req.method === "PUT" && url.host === "upload.test") {
      const id = url.pathname.split("/").pop()!;
      const s = this.sessions.get(id);
      if (!s || s.expired) return apiError(404, "notFound", "Upload session not found");
      const range = req.headers?.["Content-Range"] ?? "";
      const chunk = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
      if (chunk && req.body instanceof Blob) {
        const start = Number(chunk[1]);
        if (start !== s.receivedBytes) return res(400, "bad offset");
        const data = new Uint8Array(await req.body.arrayBuffer());
        req.onUploadProgress?.(data.length / 2);
        req.onUploadProgress?.(data.length);
        s.received.set(data, start);
        s.receivedBytes += data.length;
      }
      if (s.receivedBytes >= s.total) return this.finish(id, s);
      return res(308, "", s.receivedBytes > 0 ? { Range: `bytes=0-${s.receivedBytes - 1}` } : {});
    }

    const fileMatch = /^\/drive\/v3\/files\/([^/]+)(\/permissions)?$/.exec(url.pathname);
    if (fileMatch) {
      const f = this.files.get(decodeURIComponent(fileMatch[1]));
      if (!f) return apiError(404, "notFound", "File not found");
      if (fileMatch[2] && req.method === "POST") {
        f.permissions.push(JSON.parse(String(req.body)));
        return res(200, { id: "perm-1" });
      }
      return res(200, { ...this.view(f), trashed: false });
    }
    if (req.method === "POST" && url.pathname === "/drive/v3/files") {
      const body = JSON.parse(String(req.body));
      const id = `folder-${++this.seq}`;
      this.files.set(id, { id, name: body.name, mimeType: body.mimeType, parents: body.parents, permissions: [] });
      return res(200, { id, name: body.name });
    }
    if (url.pathname === "/drive/v3/about") {
      return res(200, { user: { displayName: "Test User", emailAddress: "test@example.com", photoLink: "https://p/1" } });
    }
    return res(400, "unknown endpoint");
  };

  private finish(sessionId: string, s: Session): HttpResponse {
    const existing = [...this.files.values()].find((f) => f.id === `file-${sessionId}`);
    if (!existing) {
      this.files.set(`file-${sessionId}`, {
        id: `file-${sessionId}`,
        name: s.metadata.name,
        mimeType: s.metadata.mimeType,
        parents: s.metadata.parents,
        data: s.received,
        permissions: [],
      });
    }
    return res(200, this.view(this.files.get(`file-${sessionId}`)!));
  }

  private view(f: { id: string; name: string; mimeType: string; parents?: string[]; data?: Uint8Array }) {
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: String(f.data?.length ?? 0),
      webViewLink: `https://drive.google.com/file/d/${f.id}/view`,
      webContentLink: `https://drive.google.com/uc?id=${f.id}&export=download`,
      parents: f.parents ?? ["root"],
    };
  }
}

export const isChunkPut = (r: HttpRequest) => r.method === "PUT" && /bytes \d+-\d+/.test(r.headers?.["Content-Range"] ?? "");
export const isStatusQuery = (r: HttpRequest) => r.method === "PUT" && /bytes \*\//.test(r.headers?.["Content-Range"] ?? "");
export const networkError = () => new TypeError("Network request failed");
