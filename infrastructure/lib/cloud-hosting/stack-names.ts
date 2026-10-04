/** Physical layouts are independent of the public cloud-hosting product name. */
export type CloudStackLayout = "lite" | "cloud";

/** The CLI supplies the discovered layout; synthesis never discovers or adopts live stacks. */
export function cloudStackLayout(env: NodeJS.ProcessEnv): CloudStackLayout {
  const layout = env.TENKACLOUD_STACK_LAYOUT ?? "cloud";
  if (layout !== "lite" && layout !== "cloud") {
    throw new Error("TENKACLOUD_STACK_LAYOUT must be lite or cloud.");
  }
  return layout;
}

/** New installs use cloud names; the CLI preserves the discovered layout for existing stacks. */
export function cloudStackNames(
  environment: string,
  layout: CloudStackLayout = "cloud",
): { app: string; backend: string } {
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(environment))
    throw new Error("Invalid cloud environment name.");
  const suffix = environment === "development" ? "" : `-${environment}`;
  return {
    app: `tenkacloud-${layout}${suffix}`,
    backend: `tenkacloud-${layout}-problem-deploy${suffix}`,
  };
}

/** Preserve the original project tag and add the current explicit ownership marker. */
export function cloudStackTags(environment: string): Record<string, string> {
  cloudStackNames(environment);
  return { Project: "TenkaCloud", TenkaCloudProject: "cloud-hosting", Environment: environment };
}
