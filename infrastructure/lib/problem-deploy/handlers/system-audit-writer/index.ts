/**
 * Compatibility entrypoint for the retired dedicated audit writer. Keeping this
 * Lambda and its log-group identity avoids deleting existing operational logs.
 * Its EventBridge rules are disabled; even an already queued delivery does no work.
 */
export function handler(_event: unknown): Promise<void> {
  return Promise.resolve();
}
