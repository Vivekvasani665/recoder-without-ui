/**
 * Optional helpers. The recorder NEVER calls these; the application decides
 * what to do with the Blob returned by stopRecording().
 */

export interface UploadOptions {
  /** Your backend URL, or a pre-signed PUT URL. Storage credentials stay server-side. */
  endpoint: string;
  method?: "POST" | "PUT";
  /** Short-lived token issued by your backend. */
  sessionToken?: string;
  fileName?: string;
  fields?: Record<string, string>;
  signal?: AbortSignal;
}

export interface UploadResult {
  ok: boolean;
  status: number;
  body: string;
}

export async function uploadRecording(blob: Blob, options: UploadOptions): Promise<UploadResult> {
  const method = options.method ?? "POST";
  const headers: Record<string, string> = {};
  if (options.sessionToken) headers.Authorization = `Bearer ${options.sessionToken}`;

  let body: Blob | FormData = blob;
  if (method === "PUT") {
    headers["Content-Type"] = blob.type || "video/webm";
  } else {
    const form = new FormData();
    form.append("file", blob, options.fileName ?? `recording-${Date.now()}.${extensionFor(blob)}`);
    for (const [k, v] of Object.entries(options.fields ?? {})) form.append(k, v);
    body = form;
  }

  const res = await fetch(options.endpoint, { method, headers, body, signal: options.signal });
  return { ok: res.ok, status: res.status, body: await res.text() };
}

/** Save to disk via a temporary object URL (no visible UI is created). */
export function downloadRecording(blob: Blob, fileName?: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName ?? `recording-${new Date().toISOString().replace(/[:.]/g, "-")}.${extensionFor(blob)}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function extensionFor(blob: Blob): string {
  return blob.type.includes("mp4") ? "mp4" : "webm";
}
