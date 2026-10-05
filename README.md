# uiless-screen-recorder

A headless screen recorder. You start it, stop it and read its timer from code. It has no UI of its own.

There are no buttons, no timer display, no preview and no recorder page. The only thing the user ever sees is the browser's native screen-sharing dialog.

```
startRecording() ─► getDisplayMedia (native picker) ─► audio pipeline ─► MediaRecorder ─► timer
getRecordingStatus() ─► { status, elapsedSeconds, ... }
stopRecording() ─► stop recorder ─► release tracks / AudioContext ─► { blob, durationSeconds, ... }
```

## Installation

```bash
npm install
```

## Build

```bash
npm run build
```

This produces:

```
dist/
├── index.js                    ESM library
├── index.d.ts (+ per-module .d.ts)
└── screen-recorder.global.js   browser bundle that sets window.ScreenRecorder
```

## Typecheck

```bash
npm run typecheck
```

## Test

```bash
npm test
```

The tests replace the browser media APIs (`getDisplayMedia`, `MediaRecorder`, `AudioContext`, ...) with fakes. They cover the lifecycle, the timer, the MIME fallback, all invalid states, error mapping and resource cleanup. They do not test real media, so check it in a real browser before shipping.

## Basic Usage

```ts
import { startRecording, stopRecording, getRecordingStatus } from "uiless-screen-recorder";

await startRecording();

console.log(getRecordingStatus());

const result = await stopRecording();

console.log(result.blob);
```

`startRecording()` resolves with a session object:

```ts
{ id: "…", status: "recording", startedAt: "2026-10-05T10:00:00.000Z", elapsedSeconds: 0,
  mimeType: "video/webm;codecs=vp9,opus", duration: null,
  audio: { microphone: "active", remote: "disabled", system: "unavailable" }, warnings: [...] }
```

`getRecordingStatus()` returns:

```ts
{ id: "…", status: "recording", elapsedSeconds: 37, elapsedMs: 37412, durationSeconds: null,
  startedAt: "…", stoppedAt: null, stopReason: null, mimeType: "…", audio: {...}, warnings: [] }
```

`stopRecording()` resolves with:

```ts
{ id: "…", status: "stopped", stopReason: "manual", durationSeconds: 42, durationMs: 42118,
  mimeType: "video/webm;codecs=vp9,opus", size: 1234567, blob: Blob, startedAt: "…", stoppedAt: "…",
  audio: {...}, warnings: [] }
```

### Full API

| Function | Description |
|---|---|
| `startRecording(options?)` | `Promise<RecordingSession>`. Opens the native picker and starts recording. |
| `stopRecording()` | `Promise<RecordingResult>`. Stops immediately and returns the Blob and its metadata. |
| `pauseRecording()` | Pauses the recorder and the timer. |
| `resumeRecording()` | Resumes the recorder and the timer. |
| `getRecordingStatus()` | `RecordingStatus` |
| `isRecording()` | `true` while recording or paused |
| `getRecordingDuration()` | Whole seconds recorded. Pauses are not counted. |
| `recorder.on(event, fn)` / `recorder.off(...)` | Events. `on` returns an unsubscribe function. |

### Timer

The recorder keeps time internally and shows no timer. `elapsedSeconds` and `getRecordingDuration()` only count time spent recording, so pauses are left out. After a recording stops, the value stays frozen at the final duration.

## Automatic Duration

```ts
await startRecording({
  duration: 60000, // ms of recorded time; pauses extend it
});
```

When the time is up, the recording finalizes on its own: `recording:stop` fires with `stopReason: "duration"`. If you call `stopRecording()` afterwards, it returns that same result, so you can still get the Blob. If you leave out `duration`, the recording runs until you call `stopRecording()`.

## Global Script API

Load the browser bundle and use `window.ScreenRecorder`:

```html
<script src="/path/to/screen-recorder.global.js"></script>
```

```ts
await ScreenRecorder.startRecording();
const status = ScreenRecorder.getRecordingStatus();
console.log(status.elapsedSeconds);
const result = await ScreenRecorder.stopRecording();
```

When you use the ESM build, `installGlobal()` sets the same object as `window.ScreenRecorder`. Typings come from `ScreenRecorderAPI`, and `Window` is augmented with them.

## Events

```ts
recorder.on("recording:start",        (session) => {});
recorder.on("recording:stop",         (result) => {});   // result.stopReason: manual | duration | screen-ended | error
recorder.on("recording:pause",        (status) => {});
recorder.on("recording:resume",       (status) => {});
recorder.on("recording:data",         ({ chunk, size, totalChunks, totalSize }) => {}); // every `timeslice` ms
recorder.on("recording:screen-ended", (status) => {});   // user clicked the browser's "Stop sharing"
recorder.on("recording:error",        (err) => {});      // RecorderError
```

## Options

```ts
await startRecording({
  duration: 60000,                       // optional auto-stop (ms)
  video: { frameRate: 30, width: 1920, height: 1080, bitsPerSecond: 5_000_000 },
  microphone: {                          // or `false` to skip the mic
    echoCancellation: false,             // all default false — see "Audio" below
    noiseSuppression: false,
    autoGainControl: false,
    deviceId: undefined,
  },
  systemAudio: true,                     // true | "required" | false
  remoteAudio: remoteCallStream,         // client voice from your own WebRTC call (optional)
  voiceIsolation: { provider: "local" }, // see "Voice isolation"
  gains: { microphone: 1, remote: 1, system: 1 },
  audioBitsPerSecond: 128_000,
  mimeType: undefined,                   // default: auto-select (see below)
  timeslice: 1000,
});
```

## Webcam bubble

```ts
await startRecording({ camera: true });
await startRecording({ camera: { position: "bottom-left", size: 0.2, mirror: true, required: false } });
```

The library draws the screen and a round webcam overlay onto an offscreen canvas and records the result, so the bubble becomes part of the video. Nothing is shown on the page. Frames are driven by a Web Worker timer, so they keep coming when the page is in the background. If the camera can't be opened, the recording continues without it and `camera` is reported as `"unavailable"`, unless you set `required: true`. Without `camera`, the raw screen track is recorded directly.

## Recorder page (example/)

`npm run dev` opens a normal recorder page at `http://localhost:5173/`:

- **Record / Stop** button with timer, live audio meters, and **Webcam bubble** / **Microphone** switches
- **Connect Google Drive** (top right). On first connect, the page creates a “Screen Recordings” folder in your Drive.
- After Stop: a video preview with **Save to Drive** (with upload progress and an “Open in Drive” link), **Download** and **Discard**
- **Saved to Google Drive** list of everything you uploaded from this browser

Google Client ID: paste it once on the page (it is stored in this browser), or put it in `example/.env.local` as `VITE_GOOGLE_CLIENT_ID=…`. In Google Cloud, add `http://localhost:5173` under *Authorized JavaScript origins*; full setup is in the Google Drive section below.

The page uses the library's public API, and `window.ScreenRecorder` is still available in the console.

## Google Drive upload (optional)

Drive support lives in `src/drive/` and stays inactive until you configure it. The recorder works the same without it, and no Google script loads until you call `drive.connect()`. There is no upload UI: the only screen anyone sees is Google's own sign-in popup.

### One-time Google Cloud setup

1. In Google Cloud Console, create a project and **enable the Google Drive API**.
2. Configure the **OAuth consent screen** and add the scope `.../auth/drive.file`. While the app is in *Testing* mode, add yourself as a test user.
3. Create an **OAuth client ID** of type **Web application** and add your page's origin under *Authorized JavaScript origins*, e.g. `http://localhost:5173` (the dev server).
4. Use the client ID in the browser. It is public. **Never put a client secret in browser code**: `configure()` rejects one.

### Usage

```ts
ScreenRecorder.drive.configure({ clientId: "1234-abc.apps.googleusercontent.com" });

await ScreenRecorder.drive.connect();        // Google's consent popup — call from a click
ScreenRecorder.drive.isConnected();          // true
ScreenRecorder.drive.getAccount();           // { name, email, photoUrl }

await ScreenRecorder.startRecording();
const result = await ScreenRecorder.stopRecording({ uploadToDrive: true });
console.log(result.drive.webViewLink);
```

```ts
{
  status: "uploaded",                 // "stopped" without upload, "upload-failed" if it failed
  recording: { durationSeconds: 125, mimeType: "video/webm", size: 12345678 },
  drive: { fileId, fileName: "recording-2026-10-05-16-30-45.webm", mimeType, size, webViewLink, webContentLink, folderId },
  blob,                               // always present, even if the upload failed
  driveError,                         // RecorderError when status is "upload-failed"
  ...
}
```

- **Auto-upload:** `startRecording({ drive: { uploadOnStop: true, fileName: "client-demo-recording.webm" } })` uploads automatically when the recording ends, whether through `stopRecording()`, `duration`, or the browser's "Stop sharing". After that, `stopRecording()` returns the uploaded result. If Drive isn't configured, the start fails before any screen prompt.
- **Upload any Blob:** `await ScreenRecorder.drive.upload(blob, { fileName, folderId, description, signal })`.
- **File name:** `recording-YYYY-MM-DD-HH-mm-ss.webm` (local time) by default. A custom name without an extension gets one added.
- **Folder:**

  ```ts
  await ScreenRecorder.drive.setFolder({ folderId: "…" }); // checked: must exist and be a folder
  await ScreenRecorder.drive.createFolder("Screen recordings", { select: true });
  await ScreenRecorder.drive.setFolder(null);               // back to "My Drive"
  ```

  With the `drive.file` scope, the app can only see folders it created itself. Use `createFolder()` for this. A folder made by hand in Drive returns `DRIVE_FOLDER_NOT_FOUND`.
- **Sharing:** uploads keep your normal private Drive permissions. Making a file public is a separate, explicit call that is never made automatically:

  ```ts
  await ScreenRecorder.drive.makeShareable(fileId);   // anyone with the link can view
  ```

### Progress events

```ts
ScreenRecorder.on("drive:upload:start",    ({ uploadId, recordingId, fileName, totalBytes }) => {});
ScreenRecorder.on("drive:upload:progress", ({ uploadedBytes, totalBytes, percentage }) => {});
ScreenRecorder.on("drive:upload:complete", ({ file }) => {});
ScreenRecorder.on("drive:upload:error",    ({ error }) => {});
```

### Large files and recovery

Uploads always use Drive's **resumable upload** protocol. The recording is sent in chunks of `chunkSize` bytes (8 MiB by default, a multiple of 256 KiB), with progress reported inside each chunk.

| Problem | What happens |
|---|---|
| Network interruption or failed chunk | Back off, ask Drive how many bytes it already has, resume from that point |
| `5xx`, `429`, rate-limit `403` | Retry with exponential backoff, up to `maxRetries` (default 5) |
| Expired upload session (`404`/`410`) | Start a new session and upload again from the beginning (at most 2 times) |
| Sign-in expired (`401`) | Renew the token silently and resend the chunk. If that fails: `GOOGLE_AUTH_EXPIRED` |

Browser tokens last about an hour and have no refresh token. Silent renewal can be blocked outside a click. For unattended uploads, pass `tokenProvider: async () => ({ accessToken, expiresAt })` and have your backend issue the tokens. Other options:

- `loginHint`: pre-fill the account chooser.
- `retryBaseDelayMs`: delay before the first retry.
- `transport`: replace the HTTP layer, e.g. for a proxy.

### Drive error codes

| Code | When |
|---|---|
| `DRIVE_INVALID_CONFIGURATION` | not configured, bad `clientId`/`chunkSize`, a client secret was passed |
| `GOOGLE_AUTH_REQUIRED` | not connected, sign-in failed, popup blocked (call `connect()` from a click) |
| `GOOGLE_AUTH_EXPIRED` | token expired and couldn't be renewed |
| `GOOGLE_PERMISSION_DENIED` | consent cancelled, Drive scope unticked, or a `403` from Drive |
| `DRIVE_FOLDER_NOT_FOUND` | folder missing, not a folder, or not visible under `drive.file` |
| `DRIVE_NETWORK_ERROR` | network kept failing after all retries |
| `DRIVE_UPLOAD_FAILED` | Drive full, session kept expiring, aborted, or another API error |

## Errors and invalid states

Every failure is a `RecorderError` with a `code` and a `source`. It rejects or throws from the call that caused it, and it is also emitted as `recording:error`.

| Situation | Code |
|---|---|
| `startRecording()` while starting, recording or paused | `ALREADY_RECORDING` |
| `stopRecording()` with nothing recorded | `NOT_RECORDING` |
| `pauseRecording()` while not recording / `resumeRecording()` while not paused | `INVALID_STATE` |
| `stopRecording()` called several times | not an error: every call gets the same result |
| User cancels or denies the screen picker | `SCREEN_PERMISSION_DENIED` |
| Microphone denied | `MICROPHONE_PERMISSION_DENIED` (or pass `microphone: false`) |
| No device / OS abort / blocked / device busy | `DEVICE_NOT_FOUND` / `CAPTURE_ABORTED` / `INSECURE_CONTEXT` / `DEVICE_IN_USE` |
| User clicks "Stop sharing" during startup | `SCREEN_SHARE_ENDED` |
| `camera: { required: true }` and the camera is denied / overlay fails | `CAMERA_PERMISSION_DENIED` / `CAMERA_OVERLAY_FAILED` |
| Browser has no `getDisplayMedia` | `UNSUPPORTED_BROWSER` |
| Browser has no `MediaRecorder` | `MEDIARECORDER_UNSUPPORTED` |
| Requested `mimeType` not supported | `MIME_TYPE_UNSUPPORTED` |
| No AudioContext, or an audio graph failure | `AUDIO_INIT_FAILED` |
| `systemAudio: "required"` but none shared | `SYSTEM_AUDIO_UNAVAILABLE` |
| Strict external provider fails | `VOICE_ISOLATION_FAILED` |

Browser support and option validity are checked **before** any permission prompt. If startup fails part-way, everything already captured is released.

When the user clicks the browser's native **Stop sharing**, `recording:screen-ended` fires. The recording then finalizes normally: status becomes `"stopped"`, `stopReason` is `"screen-ended"`, and the Blob is delivered through `recording:stop` and `stopRecording()`.

## MIME type

The first type that passes `MediaRecorder.isTypeSupported()` is used:

```
video/webm;codecs=vp9,opus → video/webm;codecs=vp8,opus → video/webm → video/mp4;codecs=avc1,mp4a → video/mp4
```

If none of them is supported, the browser's default is used.

## Audio architecture

Each audio source is captured, processed and gain-staged on its own. The sources are only combined in the final mixer:

```
AudioInput
   ├── MicrophoneAudioSource  (YOUR voice)            ─► VoiceIsolationProvider ─► Gain ─┐
   ├── RemoteAudioSource      (CLIENT voice, your call stream) ─► VoiceIsolationProvider ─► Gain ─┼─► AudioMixer
   └── SystemAudioSource      (CLIENT voice via shared system/tab audio) ─► VoiceIsolationProvider ─► Gain ─┘
                                                                                                │
                                                                         MediaStreamDestination ─► MediaRecorder (+ screen video)
```

- Every source implements `AudioSource { kind; start(): Promise<MediaStream>; stop(): void }`.
- The microphone's `echoCancellation`, `noiseSuppression` and `autoGainControl` all default to **false**. They are ordinary noise processors and are not a way to remove other voices. Turn on `echoCancellation` only if the client's voice plays through speakers into your mic. Headphones are the better fix.
- **`remoteAudio` is the most reliable way to record the client.** If your app hosts the call, pass the remote WebRTC stream. It never goes through your microphone, and it doesn't depend on system-audio support. The recorder never stops tracks it doesn't own. In Chromium, a remote WebRTC stream may need to be attached to a muted `<audio>` element in your app before Web Audio receives any sound.
- `getRecordingStatus().audio` reports each source as `active`, `unavailable` or `disabled`. `warnings` explains anything that is missing.
- Nothing is routed to the speakers, so there is no echo or feedback.

## Voice isolation

```ts
interface VoiceIsolationProvider {
  process(input: MediaStream): Promise<MediaStream>;
  dispose?(): void | Promise<void>;
}
```

Each source gets its own provider instance. `applyTo` limits which sources are processed. The default is all of them.

- **`LocalVoiceIsolationProvider`** (default) is a documented **pass-through**. It does no speaker separation, no gating and no filtering, and it doesn't claim to. What you get locally is separation by source: your mic and the client's audio are different inputs.
- **`ExternalVoiceIsolationProvider`** is the integration point for a real separation service. By default it streams the source to **your backend** over WebRTC: it POSTs an SDP offer as `application/sdp` and gets back an SDP answer. The processed track comes back on the same connection. If the connection fails, it falls back to pass-through and logs a warning. Set `fallbackToPassthrough: false` to make it fail instead. To use a WebSocket or another transport, pass `transport`.
- **Bring your own** by passing a factory function: `voiceIsolation: { provider: () => new MyProvider() }`.

```ts
await startRecording({
  voiceIsolation: {
    provider: "external",
    endpoint: "/api/voice-isolation", // YOUR server
    sessionToken,                     // optional, short-lived, issued by your server
    applyTo: ["microphone"],
  },
});
```

**Keep secrets out of the browser.** Store `VOICE_ISOLATION_API_KEY` on your server and have the server call the vendor. The provider throws if it is given an `apiKey`.

## Important Browser Limitations

- **Screen capture always needs the user's permission.** `startRecording()` opens the browser's native picker. JavaScript cannot skip it, pre-approve it, or choose the screen silently, and this library does not try to. Safari and Firefox only open the picker from a user gesture, so call `startRecording()` inside a click or keydown handler in your app. The page must be served over HTTPS or `localhost`. Inside an iframe, the frame needs `allow="display-capture; microphone"`.
- **The user picks what to share.** `displaySurface: "monitor"` preselects *Entire screen* in Chromium, but script cannot force it. If the user shares a window or tab instead, a warning is added.
- **System audio support depends on the browser and OS:**

  | Browser | System audio |
  |---|---|
  | Chromium on Windows / ChromeOS | full system audio |
  | Chromium on macOS | only recent versions on macOS 14.2+ |
  | Chromium on Linux | generally tab audio only |
  | Firefox, Safari | no system audio |

  The user also has to tick the "share audio" box in the picker. If system audio is missing, its status is `"unavailable"` with a warning. Pass `systemAudio: "required"` to make it an error instead.
- **Browser APIs alone cannot reliably identify individual speakers inside a mixed microphone track.** If you, a colleague and a TV are all picked up by one mic, the browser gets one waveform. It cannot label which voice is the client and which is someone else. `noiseSuppression`, volume thresholds and frequency filters don't change this: they reduce noise and treat every voice the same. That is why none of them is presented here as voice isolation.
- **Real speaker or source separation needs a suitable model or provider**, such as target-speaker extraction, source separation or diarization. Plug it in through `ExternalVoiceIsolationProvider` or your own `VoiceIsolationProvider`.

## Recording data

The recorder never uploads anything. `stopRecording()` returns the Blob, and your application decides what to do with it. There are two optional helpers, and the recorder never calls either of them:

```ts
import { uploadRecording, downloadRecording } from "uiless-screen-recorder";

const { blob } = await stopRecording();
await uploadRecording(blob, { endpoint: "/api/recordings" });          // multipart POST to your backend
await uploadRecording(blob, { endpoint: presignedUrl, method: "PUT" }); // pre-signed S3/GCS URL
downloadRecording(blob);                                                // save locally
```

For long sessions, stream the chunks from `recording:data` to your backend while recording.

## Project structure

```
src/
├── index.ts                    public exports, ScreenRecorder object, installGlobal()
├── global.ts                   browser-bundle entry (sets window.ScreenRecorder)
├── api/                        startRecording, stopRecording, pause/resume, recordingStatus, types
├── recorder/                   Recorder (state machine), RecorderSession, MediaRecorderController, RecordingTimer
├── capture/                    ScreenCapture (getDisplayMedia), CameraCapture, VideoCompositor (webcam bubble), CaptureTypes
├── audio/                      AudioSource + Microphone/Remote/System sources, AudioManager, AudioMixer, VoiceIsolationProvider
├── providers/                  LocalVoiceIsolationProvider, ExternalVoiceIsolationProvider
├── drive/                      Google Drive: GoogleDriveClient, GoogleDriveAuth, GoogleDriveUploader, GoogleDriveConfig, GoogleDriveTypes, http
├── events/                     RecorderEvents (typed emitter)
└── utils/                      mime, errors, ids, upload (optional helpers)
tests/                          recorder, timer, mime (+ browser API fakes)
example/script-example.ts       script-only usage (no UI)
example/index.html + main.ts     recorder page: Record/Stop, Connect Drive, Save to Drive / Download
```
