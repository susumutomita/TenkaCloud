import { runCoordinationTick } from "../../coordination-tick-runner.js";

/**
 * Minimal-IAM companion target on GenericScoring's one-minute EventBridge rule.
 * Reviewed problem plugins execute here, isolated from scoring's SSM/KMS/EventBridge
 * permissions and limited to the coordination row, event roster, and bundle bucket.
 */
export async function handler(): Promise<void> {
  await runCoordinationTick();
}
