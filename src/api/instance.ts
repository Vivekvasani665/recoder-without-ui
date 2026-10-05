import { GoogleDriveClient } from "../drive/GoogleDriveClient";
import { RecorderEvents, type RecorderEventMap } from "../events/RecorderEvents";
import { Recorder } from "../recorder/Recorder";

/** One event bus shared by the recorder and the Drive module. */
export const events = new RecorderEvents();

/** The shared headless recorder behind the functional API. */
export const recorder = new Recorder(events);

/** Google Drive integration (inactive until configured). */
export const drive = new GoogleDriveClient({
  // DriveEventMap is a subset of RecorderEventMap, so payload types match.
  emit: (event, payload) => events.emit(event, payload as RecorderEventMap[typeof event]),
});
