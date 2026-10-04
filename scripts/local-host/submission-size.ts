/** A workbench request is capped at 64 KiB. Its sealed code answer can grow
 * through JSON/base64 encoding, so only the scoring endpoint gets this larger
 * bounded envelope. Ordinary API limits remain unchanged. */
export const MAX_SUBMISSION_BODY = 128 * 1024;

export function apiBodyLimit(path: string, ordinaryLimit: number): number {
  return path === "/portal/me/submit-flag" ? MAX_SUBMISSION_BODY : ordinaryLimit;
}
