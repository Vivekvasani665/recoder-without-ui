import { RecorderError } from "../utils/errors";
import type { CameraOptions } from "./CaptureTypes";

/**
 * Draws the screen with a round webcam bubble onto a canvas and exposes the
 * result as a video track (canvas.captureStream), which is what gets recorded.
 *
 * Frames are driven by a Web Worker timer instead of requestAnimationFrame:
 * rAF stops entirely when the page is hidden, which is the normal case while
 * recording the whole screen with another app in front. Worker timers keep
 * ticking in background tabs.
 *
 * The <video> elements and canvas are created detached and never added to
 * the page, so nothing is shown.
 */
const TICKER_SOURCE = `let id=null;onmessage=(e)=>{clearInterval(id);if(e.data>0)id=setInterval(()=>postMessage(0),e.data);};`;

export class VideoCompositor {
  private screenVideo: HTMLVideoElement | null = null;
  private cameraVideo: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private output: MediaStreamTrack | null = null;
  private worker: Worker | null = null;
  private workerUrl: string | null = null;
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;

  async start(screenTrack: MediaStreamTrack, camera: MediaStream, frameRate: number, options: CameraOptions): Promise<MediaStreamTrack> {
    if (typeof document === "undefined") {
      throw new RecorderError("UNSUPPORTED_BROWSER", "Camera overlay needs a DOM (canvas + video).", "compositor");
    }
    try {
      this.screenVideo = await playDetached(new MediaStream([screenTrack]));
      this.cameraVideo = await playDetached(camera);

      const width = this.screenVideo.videoWidth || screenTrack.getSettings().width || 1920;
      const height = this.screenVideo.videoHeight || screenTrack.getSettings().height || 1080;
      this.canvas = document.createElement("canvas");
      this.canvas.width = width;
      this.canvas.height = height;
      const ctx = this.canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("2D canvas context unavailable");

      const draw = () => this.drawFrame(ctx, width, height, options);
      draw();
      this.output = this.canvas.captureStream(frameRate).getVideoTracks()[0] ?? null;
      if (!this.output) throw new Error("canvas.captureStream returned no track");
      this.startTicker(draw, Math.round(1000 / frameRate));
      return this.output;
    } catch (err) {
      this.stop();
      throw err instanceof RecorderError
        ? err
        : new RecorderError("CAMERA_OVERLAY_FAILED", `Could not composite the camera onto the screen: ${String(err)}`, "compositor", err);
    }
  }

  private drawFrame(ctx: CanvasRenderingContext2D, w: number, h: number, options: CameraOptions): void {
    const screen = this.screenVideo;
    const cam = this.cameraVideo;
    if (!screen || !cam) return;
    ctx.drawImage(screen, 0, 0, w, h);

    const camW = cam.videoWidth;
    const camH = cam.videoHeight;
    if (!camW || !camH) return;

    const d = Math.round(Math.min(w, h) * (options.size ?? 0.22));
    const margin = Math.round(Math.min(w, h) * 0.03);
    const pos = options.position ?? "bottom-right";
    const x = pos.endsWith("left") ? margin : w - margin - d;
    const y = pos.startsWith("top") ? margin : h - margin - d;

    // Center-crop the webcam to a square.
    const side = Math.min(camW, camH);
    const sx = (camW - side) / 2;
    const sy = (camH - side) / 2;

    ctx.save();
    ctx.beginPath();
    ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
    ctx.clip();
    if (options.mirror ?? true) {
      ctx.translate(x + d, y);
      ctx.scale(-1, 1);
      ctx.drawImage(cam, sx, sy, side, side, 0, 0, d, d);
    } else {
      ctx.drawImage(cam, sx, sy, side, side, x, y, d, d);
    }
    ctx.restore();

    ctx.beginPath();
    ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(3, Math.round(d * 0.025));
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.stroke();
  }

  private startTicker(tick: () => void, intervalMs: number): void {
    try {
      this.workerUrl = URL.createObjectURL(new Blob([TICKER_SOURCE], { type: "text/javascript" }));
      this.worker = new Worker(this.workerUrl);
      this.worker.onmessage = tick;
      this.worker.postMessage(intervalMs);
    } catch {
      // CSP may forbid blob: workers; plain timers still work while visible.
      this.fallbackTimer = setInterval(tick, intervalMs);
    }
  }

  stop(): void {
    this.worker?.postMessage(0);
    this.worker?.terminate();
    this.worker = null;
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = null;
    if (this.fallbackTimer !== null) clearInterval(this.fallbackTimer);
    this.fallbackTimer = null;
    this.output?.stop();
    this.output = null;
    for (const v of [this.screenVideo, this.cameraVideo]) {
      if (!v) continue;
      v.pause();
      v.srcObject = null;
    }
    this.screenVideo = null;
    this.cameraVideo = null;
    this.canvas = null;
  }
}

async function playDetached(stream: MediaStream): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth) {
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      video.addEventListener("loadedmetadata", done, { once: true });
      setTimeout(done, 1000);
    });
  }
  return video;
}
