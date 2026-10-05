/** Ordered by preference; the first one the browser supports wins. */
export const MIME_TYPE_CANDIDATES: readonly string[] = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4;codecs=avc1,mp4a", // Safari
  "video/mp4",
];

export function isMimeTypeSupported(type: string): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof MediaRecorder.isTypeSupported === "function" &&
    MediaRecorder.isTypeSupported(type)
  );
}

/**
 * Returns the first supported MIME type, checked with
 * MediaRecorder.isTypeSupported(). Returns "" when none match, which tells
 * MediaRecorder to use the browser default.
 */
export function getSupportedMimeType(candidates: readonly string[] = MIME_TYPE_CANDIDATES): string {
  return candidates.find(isMimeTypeSupported) ?? "";
}
