export interface ScreenCaptureOptions {
  frameRate: number;
  width?: number;
  height?: number;
  /** Ask the browser to include system/tab audio in the share. */
  systemAudio: boolean;
}

export type DisplaySurface = "monitor" | "window" | "browser" | "unknown";

export type CameraPosition = "bottom-right" | "bottom-left" | "top-right" | "top-left";

export interface CameraOptions {
  deviceId?: string;
  /** Corner for the webcam bubble. Default "bottom-right". */
  position?: CameraPosition;
  /** Bubble diameter as a fraction of the shorter screen side. Default 0.22. */
  size?: number;
  /** Mirror the webcam like a selfie view. Default true. */
  mirror?: boolean;
  /** Fail the start if the camera can't be opened. Default false (record without it). */
  required?: boolean;
}
