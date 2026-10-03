/**
 * Issue #2291: Lambda CFn deploy handler entry point.
 *
 * Routing-only dispatch: the SDK clients + orchestration live in `create-stack.ts` / `delete-stack.ts`
 * so this `index.ts` stays free of direct `@aws-sdk/client-*` imports (handler-no-direct-sdk-import
 * rule). The state machines invoke this one Lambda with an explicit `action`:
 *   - unset / "create"  → CreateStack (backward compatible; the create SM sends no `action`)
 *   - "delete"          → DeleteStack (returns after submit; the delete SM then polls)
 *   - "describe-delete" → one DescribeStacks poll iteration for the delete Wait/poll loop
 */
import { handler as createStackHandler } from "./create-stack.js";
import { deleteHandler, describeDeleteHandler } from "./delete-stack.js";

export interface CfnDeployDispatchInput {
  readonly action?: "create" | "delete" | "describe-delete";
  readonly detail?: unknown;
}

export async function handler(input: CfnDeployDispatchInput): Promise<unknown> {
  switch (input?.action) {
    case "delete":
      return deleteHandler(input);
    case "describe-delete":
      return describeDeleteHandler(input);
    default:
      return createStackHandler(input);
  }
}
