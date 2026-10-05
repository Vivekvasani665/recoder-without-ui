/**
 * Screen Recorder page: Record/Stop, Connect Google Drive, and after a
 * recording "Save to Drive" or "Download". All recording/Drive logic is in
 * the library (src/); this file only wires the page to it.
 *
 * window.ScreenRecorder is still exposed for console/script control.
 */
import {
  ScreenRecorder,
  downloadRecording,
  type RecordingResult,
  type RecordingSession,
} from "../src/index";
import { loadGoogleIdentityServices } from "../src/drive/GoogleDriveAuth";
import { RecorderError } from "../src/utils/errors";

const R = ScreenRecorder;
const drive = R.drive;
window.ScreenRecorder = R;

// ─── Small helpers ─────────────────────────────────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* storage unavailable: settings just won't persist */
    }
  },
};
const fmt = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${m}:${sec}` : `${m}:${sec}`;
};
const fmtSize = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const KEYS = { clientId: "sr.clientId", email: "sr.email", folderId: "sr.folderId", history: "sr.history" };
const FOLDER_NAME = "Screen Recordings";

const CLIENT_ID_RE = /^[\w-]+\.apps\.googleusercontent\.com$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const envClientId = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_GOOGLE_CLIENT_ID;

// Drop a previously saved value that isn't a real Client ID (e.g. an email).
const savedClientId = store.get(KEYS.clientId);
if (savedClientId && !CLIENT_ID_RE.test(savedClientId)) {
  if (EMAIL_RE.test(savedClientId)) store.set(KEYS.email, savedClientId);
  store.set(KEYS.clientId, null);
}
const getClientId = () => (envClientId && CLIENT_ID_RE.test(envClientId) ? envClientId : store.get(KEYS.clientId));

// ─── Elements ──────────────────────────────────────────────────────────────

const recordBtn = $<HTMLButtonElement>("record");
const label = $("label");
const timer = $("timer");
const notice = $("notice");
const optCamera = $<HTMLInputElement>("opt-camera");
const optMic = $<HTMLInputElement>("opt-mic");
const result = $("result");
const player = $<HTMLVideoElement>("player");
const meta = $("meta");
const downloadLink = $<HTMLAnchorElement>("download");
const saveDriveBtn = $<HTMLButtonElement>("save-drive");
const progress = $("progress");
const progressBar = progress.querySelector<HTMLElement>(".bar > span")!;
const progressText = $("progress-text");
const saved = $("saved");

function showNotice(kind?: "ok" | "warn" | "err", text?: string): void {
  if (!kind || !text) {
    notice.hidden = true;
    return;
  }
  notice.className = `notice ${kind}`;
  notice.textContent = text;
  notice.hidden = false;
}

// ─── Google Drive connection ───────────────────────────────────────────────

function renderDrive(): void {
  const account = drive.getAccount();
  const connected = drive.isConnected();
  $("drive-out").hidden = connected;
  $("drive-in").hidden = !connected;
  $("email").textContent = account?.email ?? "Google account";
  const avatar = $<HTMLImageElement>("avatar");
  avatar.hidden = !account?.photoUrl;
  if (account?.photoUrl) avatar.src = account.photoUrl;
}

/** Uses the saved "Screen Recordings" folder, or creates it (drive.file can only see app-created folders). */
async function ensureFolder(): Promise<void> {
  const savedId = store.get(KEYS.folderId);
  if (savedId) {
    try {
      await drive.setFolder({ folderId: savedId });
      return;
    } catch {
      /* deleted or inaccessible: create a new one */
    }
  }
  const folder = await drive.createFolder(FOLDER_NAME, { select: true });
  store.set(KEYS.folderId, folder.folderId);
}

/** Must be called from a click (Google's popup). Returns true when connected. */
async function connectDrive(): Promise<boolean> {
  const clientId = getClientId();
  if (!clientId) {
    openSetup();
    return false;
  }
  try {
    drive.configure({ clientId, loginHint: store.get(KEYS.email) ?? undefined });
    const account = await drive.connect();
    if (account?.email) store.set(KEYS.email, account.email);
    await ensureFolder();
    $("setup").hidden = true;
    renderDrive();
    showNotice("ok", `Google Drive connected. Recordings will be saved to “${FOLDER_NAME}”.`);
    return true;
  } catch (err) {
    renderDrive();
    const code = err instanceof RecorderError ? err.code : "";
    if (code === "DRIVE_INVALID_CONFIGURATION") {
      openSetup(errorText(err));
    } else {
      showNotice(code === "GOOGLE_PERMISSION_DENIED" ? "warn" : "err", googleHelp(err));
    }
    return false;
  }
}

$("connect").addEventListener("click", () => void connectDrive());

$("disconnect").addEventListener("click", async () => {
  await drive.disconnect();
  renderDrive();
  showNotice("ok", "Google Drive disconnected.");
});

function setupError(text?: string): void {
  const el = $("setup-error");
  el.textContent = text ?? "";
  el.hidden = !text;
}

function openSetup(error?: string): void {
  $("setup").hidden = false;
  $("origin").textContent = location.origin;
  const email = store.get(KEYS.email);
  if (email) $("your-email").textContent = email;
  setupError(error);
  showNotice();
  $("setup").scrollIntoView({ behavior: "smooth", block: "start" });
  $<HTMLInputElement>("client-id").focus();
}

/** Turn common Google errors into a next step. */
function googleHelp(err: unknown): string {
  const text = errorText(err);
  if (/redirect_uri_mismatch|origin/i.test(text)) {
    return `${text} Add ${location.origin} under "Authorized JavaScript origins" for your Client ID.`;
  }
  if (/access_denied|cancelled/i.test(text)) {
    return `${text} If the app is in Testing mode, add your Gmail under Audience → Test users.`;
  }
  return text;
}

$("save-client").addEventListener("click", () => {
  const value = $<HTMLInputElement>("client-id").value.trim();
  if (!value) {
    setupError("Paste your Client ID first.");
    return;
  }
  if (EMAIL_RE.test(value)) {
    store.set(KEYS.email, value);
    $("your-email").textContent = value;
    setupError(
      `"${value}" is your email, not a Client ID. Follow steps 1–4 above to create a Client ID (it ends in .apps.googleusercontent.com), then paste that here. Your email is saved and will be pre-selected when you sign in.`,
    );
    return;
  }
  if (!CLIENT_ID_RE.test(value)) {
    setupError("That doesn't look like a Client ID. It should look like 1234567890-abc123.apps.googleusercontent.com (step 4 above).");
    return;
  }
  setupError();
  store.set(KEYS.clientId, value);
  void loadGoogleIdentityServices().catch(() => undefined);
  void connectDrive();
});

$("copy-origin").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.origin);
    $("copy-origin").textContent = "Copied";
  } catch {
    $("copy-origin").textContent = "Copy failed";
  }
  setTimeout(() => ($("copy-origin").textContent = "Copy"), 1500);
});

// Load Google's sign-in script early so the popup opens directly from the click.
if (getClientId()) void loadGoogleIdentityServices().catch(() => undefined);
$<HTMLInputElement>("client-id").value = store.get(KEYS.clientId) ?? "";

// ─── Recording ─────────────────────────────────────────────────────────────

let tick: ReturnType<typeof setInterval> | undefined;
let busy = false;

function setRecordingUI(on: boolean): void {
  recordBtn.classList.toggle("on", on);
  recordBtn.setAttribute("aria-label", on ? "Stop recording" : "Start recording");
  label.textContent = on ? "Stop" : "Start recording";
  timer.classList.toggle("live", on);
  optCamera.disabled = on;
  optMic.disabled = on;
  $("meters").hidden = !on;
  clearInterval(tick);
  if (on) {
    tick = setInterval(() => {
      timer.textContent = fmt(R.getRecordingDuration());
      updateMeters();
    }, 100);
  }
}

function updateMeters(): void {
  const levels = R.getAudioLevels();
  const audio = R.getRecordingStatus().audio;
  for (const kind of ["microphone", "system"] as const) {
    const row = $(`m-${kind}`);
    const active = audio?.[kind] === "active";
    row.querySelector("span")!.textContent = (kind === "microphone" ? "Microphone" : "Computer audio") + (active ? "" : " (off)");
    const pct = active ? Math.min(100, Math.round(Math.sqrt(levels[kind] ?? 0) * 220)) : 0;
    row.querySelector<HTMLElement>(".bar > span")!.style.width = `${pct}%`;
  }
}

function startWarnings(session: RecordingSession): string {
  const notes: string[] = [];
  if (session.camera === "unavailable") notes.push("Webcam couldn't be opened, so recording without it.");
  if (session.audio.system === "unavailable") notes.push("Computer audio wasn't shared, so only your mic is recorded.");
  if (session.warnings.some((w) => /suspended/.test(w))) notes.push("The browser blocked audio; the recording may be silent.");
  return notes.join(" ");
}

async function start(): Promise<void> {
  busy = true;
  recordBtn.disabled = true;
  label.textContent = "Choose what to share…";
  showNotice();
  try {
    const session = await R.startRecording({
      camera: optCamera.checked ? { position: "bottom-right" } : false,
      microphone: optMic.checked ? {} : false,
    });
    timer.textContent = "00:00";
    setRecordingUI(true);
    const warn = startWarnings(session);
    if (warn) showNotice("warn", warn);
  } catch (err) {
    setRecordingUI(false);
    const cancelled = err instanceof RecorderError && err.code === "SCREEN_PERMISSION_DENIED";
    showNotice(cancelled ? "warn" : "err", cancelled ? "Screen sharing was cancelled." : errorText(err));
  } finally {
    busy = false;
    recordBtn.disabled = false;
  }
}

async function stop(): Promise<void> {
  busy = true;
  recordBtn.disabled = true;
  label.textContent = "Saving…";
  try {
    await R.stopRecording(); // the page updates in the recording:stop handler
  } catch (err) {
    showNotice("err", errorText(err));
    setRecordingUI(false);
  } finally {
    busy = false;
    recordBtn.disabled = false;
  }
}

recordBtn.addEventListener("click", () => {
  if (busy) return;
  void (R.isRecording() ? stop() : start());
});

// ─── Result: preview, Save to Drive, Download ──────────────────────────────

let current: RecordingResult | null = null;
let objectUrl: string | null = null;

R.on("recording:stop", (rec) => {
  setRecordingUI(false);
  timer.textContent = fmt(rec.durationSeconds);
  if (rec.stopReason === "screen-ended") showNotice("warn", "Recording stopped because screen sharing ended.");
  showResult(rec);
});

function showResult(rec: RecordingResult): void {
  current = rec;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(rec.blob);

  player.src = objectUrl;
  // MediaRecorder WebM has no duration header; seek once so the timeline works.
  player.addEventListener(
    "loadedmetadata",
    () => {
      if (player.duration === Infinity) {
        player.currentTime = 1e101;
        player.addEventListener("timeupdate", () => (player.currentTime = 0), { once: true });
      }
    },
    { once: true },
  );

  const ext = rec.mimeType.includes("mp4") ? "mp4" : "webm";
  const stamp = new Date(rec.startedAt).toISOString().slice(0, 19).replace(/[T:]/g, "-");
  downloadLink.href = objectUrl;
  downloadLink.download = `recording-${stamp}.${ext}`;
  const sounds = [rec.audio.microphone === "active" && "mic", rec.audio.system === "active" && "computer audio"].filter(Boolean);
  meta.textContent = `${fmt(rec.durationSeconds)} · ${fmtSize(rec.size)} · ${ext.toUpperCase()}${
    rec.camera === "active" ? " · with webcam" : ""
  } · ${sounds.length ? `audio: ${sounds.join(" + ")}` : "no audio"}`;

  saveDriveBtn.disabled = false;
  saveDriveBtn.lastChild!.textContent = " Save to Drive";
  progress.hidden = true;
  saved.hidden = true;
  result.hidden = false;
  result.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

saveDriveBtn.addEventListener("click", async () => {
  if (!current) return;
  const rec = current;
  if (!drive.isConnected() && !(await connectDrive())) return;

  saveDriveBtn.disabled = true;
  saved.hidden = true;
  progress.hidden = false;
  progressBar.style.width = "0%";
  progressText.textContent = "Uploading to Google Drive… 0%";

  const off = R.on("drive:upload:progress", (p) => {
    progressBar.style.width = `${p.percentage}%`;
    progressText.textContent = `Uploading to Google Drive… ${p.percentage}% (${fmtSize(p.uploadedBytes)} of ${fmtSize(p.totalBytes)})`;
  });
  try {
    const file = await drive.upload(rec.blob, { recordingId: rec.id });
    progress.hidden = true;
    saved.className = "notice ok";
    saved.innerHTML = "";
    saved.append("Saved to Google Drive ✓ ");
    if (file.webViewLink) {
      const a = document.createElement("a");
      a.href = file.webViewLink;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Open in Drive";
      saved.append(a);
    }
    saved.hidden = false;
    saveDriveBtn.lastChild!.textContent = " Saved";
    addHistory({ name: file.fileName, link: file.webViewLink ?? "", at: Date.now(), size: file.size });
  } catch (err) {
    progress.hidden = true;
    saved.className = "notice err";
    saved.textContent = `Couldn't save to Drive: ${errorText(err)} Your recording is still here; try again or Download it.`;
    saved.hidden = false;
    saveDriveBtn.disabled = false;
  } finally {
    off();
  }
});

$("discard").addEventListener("click", () => {
  player.removeAttribute("src");
  player.load();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  current = null;
  result.hidden = true;
  timer.textContent = "00:00";
  showNotice();
});

R.on("recording:error", (err) => {
  if (R.isRecording()) showNotice("err", err.message);
});

// ─── Saved-to-Drive history (this browser) ─────────────────────────────────

interface HistoryItem {
  name: string;
  link: string;
  at: number;
  size: number;
}

function readHistory(): HistoryItem[] {
  try {
    return JSON.parse(store.get(KEYS.history) ?? "[]") as HistoryItem[];
  } catch {
    return [];
  }
}

function addHistory(item: HistoryItem): void {
  store.set(KEYS.history, JSON.stringify([item, ...readHistory()].slice(0, 50)));
  renderHistory();
}

function renderHistory(): void {
  const items = readHistory();
  const list = $("history");
  list.innerHTML = "";
  $("history-empty").hidden = items.length > 0;
  for (const item of items) {
    const li = document.createElement("li");
    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = item.name;
    const when = document.createElement("div");
    when.className = "when";
    when.textContent = `${new Date(item.at).toLocaleString()} · ${fmtSize(item.size)}`;
    info.append(name, when);
    li.append(info);
    if (item.link) {
      const a = document.createElement("a");
      a.className = "btn small";
      a.href = item.link;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Open in Drive";
      li.append(a);
    }
    list.append(li);
  }
}

renderHistory();
renderDrive();

// Console helpers (optional).
Object.assign(window, { downloadRecording });
