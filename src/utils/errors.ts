export type RecorderErrorCode =
  | "ALREADY_RECORDING"
  | "NOT_RECORDING"
  | "INVALID_STATE"
  | "INVALID_OPTIONS"
  | "UNSUPPORTED_BROWSER"
  | "INSECURE_CONTEXT"
  | "MEDIARECORDER_UNSUPPORTED"
  | "MIME_TYPE_UNSUPPORTED"
  | "SCREEN_PERMISSION_DENIED"
  | "MICROPHONE_PERMISSION_DENIED"
  | "CAMERA_PERMISSION_DENIED"
  | "CAMERA_OVERLAY_FAILED"
  | "DEVICE_NOT_FOUND"
  | "DEVICE_IN_USE"
  | "CAPTURE_ABORTED"
  | "SCREEN_SHARE_ENDED"
  | "SYSTEM_AUDIO_UNAVAILABLE"
  | "REMOTE_AUDIO_UNAVAILABLE"
  | "AUDIO_INIT_FAILED"
  | "VOICE_ISOLATION_FAILED"
  | "RECORDER_FAILED"
  | "GOOGLE_AUTH_REQUIRED"
  | "GOOGLE_AUTH_EXPIRED"
  | "GOOGLE_PERMISSION_DENIED"
  | "DRIVE_UPLOAD_FAILED"
  | "DRIVE_FOLDER_NOT_FOUND"
  | "DRIVE_NETWORK_ERROR"
  | "DRIVE_INVALID_CONFIGURATION"
  | "UNKNOWN";

export type RecorderErrorSource =
  | "state"
  | "browser"
  | "screen"
  | "microphone"
  | "camera"
  | "compositor"
  | "system-audio"
  | "remote-audio"
  | "audio"
  | "voice-isolation"
  | "recorder"
  | "google-auth"
  | "drive";

export class RecorderError extends Error {
  readonly code: RecorderErrorCode;
  readonly source: RecorderErrorSource;
  readonly cause?: unknown;

  constructor(code: RecorderErrorCode, message: string, source: RecorderErrorSource, cause?: unknown) {
    super(message);
    this.name = "RecorderError";
    this.code = code;
    this.source = source;
    this.cause = cause;
  }
}

export function isRecorderError(err: unknown): err is RecorderError {
  return err instanceof RecorderError;
}

/**
 * Converts DOMExceptions thrown by getDisplayMedia / getUserMedia into
 * typed, actionable RecorderErrors.
 */
export function fromMediaError(err: unknown, source: "screen" | "microphone" | "camera"): RecorderError {
  if (err instanceof RecorderError) return err;

  const name = (err as { name?: unknown } | null)?.name;
  const detail = (err as { message?: unknown } | null)?.message;
  const isScreen = source === "screen";
  const label = isScreen ? "Screen capture" : source === "camera" ? "Camera capture" : "Microphone capture";
  const device = isScreen ? "The screen" : source === "camera" ? "The camera" : "The microphone";

  switch (name) {
    case "NotAllowedError":
      if (source === "camera") {
        return new RecorderError(
          "CAMERA_PERMISSION_DENIED",
          "Camera access was denied. Allow the camera for this site (and in OS privacy settings), or start without `camera`.",
          source,
          err,
        );
      }
      return isScreen
        ? new RecorderError(
            "SCREEN_PERMISSION_DENIED",
            "Screen capture was cancelled or denied. Pick 'Entire screen' in the browser dialog and click Share. On macOS the browser also needs System Settings → Privacy & Security → Screen Recording.",
            source,
            err,
          )
        : new RecorderError(
            "MICROPHONE_PERMISSION_DENIED",
            "Microphone access was denied. Allow the microphone for this site (and in OS privacy settings), or start with `microphone: false`.",
            source,
            err,
          );
    case "NotFoundError":
    case "OverconstrainedError":
      return new RecorderError(
        "DEVICE_NOT_FOUND",
        isScreen ? "No screen capture source is available." : `No matching ${source} was found. Check the device or \`${source}.deviceId\`.`,
        source,
        err,
      );
    case "AbortError":
      return new RecorderError(
        "CAPTURE_ABORTED",
        `${label} was aborted by the browser or operating system.`,
        source,
        err,
      );
    case "SecurityError":
      return new RecorderError(
        "INSECURE_CONTEXT",
        "Capture is blocked by browser security. Serve the page over HTTPS (or localhost) and, inside an iframe, add allow=\"display-capture; microphone\".",
        source,
        err,
      );
    case "NotReadableError":
      return new RecorderError(
        "DEVICE_IN_USE",
        `${device} could not be read; it may be in use or blocked by the OS.`,
        source,
        err,
      );
    default:
      return new RecorderError(
        "UNKNOWN",
        `${label} failed${typeof detail === "string" ? `: ${detail}` : "."}`,
        source,
        err,
      );
  }
}
