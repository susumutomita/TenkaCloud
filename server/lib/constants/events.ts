/** Custom EventBridge event detail-types for TenkaCloud. */
export const EVENTS = {
  PROBLEM_DEPLOY_REQUESTED: "problem.deploy.requested",
  PROBLEM_DEPLOY_COMPLETED: "problem.deploy.completed",
  PROBLEM_DEPLOY_FAILED: "problem.deploy.failed",
} as const;

/** Custom EventBridge event sources for TenkaCloud. */
export const EVENT_SOURCES = {
  PROBLEM_SERVICE: "tenkacloud.problem-service",
  PROBLEM_DEPLOY_PLANE: "tenkacloud.problem-deploy-plane",
} as const;
