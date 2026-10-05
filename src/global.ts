/**
 * Entry for the browser bundle (dist/screen-recorder.global.js).
 * Loading it sets `window.ScreenRecorder`:
 *
 *   await ScreenRecorder.startRecording();
 *   ScreenRecorder.getRecordingStatus().elapsedSeconds;
 *   const result = await ScreenRecorder.stopRecording();
 */
import { installGlobal } from "./index";

installGlobal();
