import { RecorderError, fromMediaError } from "../utils/errors";
import type { CameraOptions } from "./CaptureTypes";

/** Webcam capture (video only), used for the picture-in-picture bubble. */
export class CameraCapture {
  private stream: MediaStream | null = null;

  async start(options: CameraOptions): Promise<MediaStream> {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getUserMedia !== "function") {
      throw new RecorderError("UNSUPPORTED_BROWSER", "navigator.mediaDevices.getUserMedia is not available.", "browser");
    }
    const video: MediaTrackConstraints = {
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30 },
    };
    if (options.deviceId) video.deviceId = { exact: options.deviceId };

    try {
      this.stream = await md.getUserMedia({ video, audio: false });
    } catch (err) {
      throw fromMediaError(err, "camera");
    }
    if (this.stream.getVideoTracks().length === 0) {
      this.stop();
      throw new RecorderError("DEVICE_NOT_FOUND", "The camera stream has no video track.", "camera");
    }
    return this.stream;
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
