/** Shared by the CDK app and CLI, preserving the former single-installation suffix rule. */
export function cloudStackNames(environment: string): { app: string; backend: string } {
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(environment))
    throw new Error("Invalid cloud environment name.");
  const suffix = environment === "development" ? "" : `-${environment}`;
  return { app: `tenkacloud-cloud${suffix}`, backend: `tenkacloud-cloud-problem-deploy${suffix}` };
}

/** Stack-level ownership tags are also verified before any update or destruction. */
export function cloudStackTags(environment: string): Record<string, string> {
  cloudStackNames(environment);
  return { TenkaCloudProject: "cloud-hosting", Environment: environment };
}
