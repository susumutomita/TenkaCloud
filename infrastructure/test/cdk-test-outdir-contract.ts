export const CDK_TEST_RUN_ID_ENV = "TENKACLOUD_CDK_TEST_RUN_ID";
export const CDK_TEST_RUN_ID_PATTERN = /^run-\d+-[A-Za-z0-9_-]+$/;

export function resolveCdkTestRunId(
  env: Pick<NodeJS.ProcessEnv, "TENKACLOUD_CDK_TEST_RUN_ID"> = process.env,
  fallbackPid = process.pid,
): string {
  const runId = env.TENKACLOUD_CDK_TEST_RUN_ID ?? `direct-${fallbackPid}`;
  if (!CDK_TEST_RUN_ID_PATTERN.test(runId) && !/^direct-\d+$/.test(runId)) {
    throw new Error(`invalid ${CDK_TEST_RUN_ID_ENV}: ${runId}`);
  }
  return runId;
}

export function resolveVitestWorkerId(
  env: Pick<NodeJS.ProcessEnv, "VITEST_WORKER_ID"> = process.env,
): string {
  const workerId = env.VITEST_WORKER_ID ?? "0";
  if (!/^\d+$/.test(workerId)) {
    throw new Error(`invalid VITEST_WORKER_ID: ${workerId}`);
  }
  return workerId;
}
