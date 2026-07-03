/**
 * Issue #2291 (ADR-049 §9): Lambda CreateStack deploy handler entry point.
 *
 * Routing-only re-export: the SDK clients + orchestration live in `create-stack.ts` so this
 * `index.ts` stays free of direct `@aws-sdk/client-*` imports (handler-no-direct-sdk-import rule).
 */
export { handler } from "./create-stack.js";
