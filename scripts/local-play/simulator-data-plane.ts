import type { SimulatedCloudProblem } from "./simulator";
import { type NativeTarget, nativeTargets } from "./simulator-native-environment";

const SYNTHETIC_HTTP_HOSTS: Readonly<
  Record<NativeTarget["provider"], readonly RegExp[] | undefined>
> = {
  aws: [
    /^[a-z0-9-]+\.elb\.[a-z0-9-]+\.amazonaws\.com$/,
    /^[a-z0-9-]+\.lambda-url\.[a-z0-9-]+\.on\.aws$/,
  ],
  azure: [/^[a-z0-9-]+\.azurecontainerapps\.local$/],
  gcp: [/^[a-z0-9-]+\.run\.gcp\.local$/],
  sakura: [/^[a-z0-9-]+\.apprun\.sakura\.local$/],
};

function targetForOutput(problem: SimulatedCloudProblem, key: string): NativeTarget | undefined {
  const targets = nativeTargets(problem);
  if (!("kind" in problem.runtime)) return targets[0];
  return targets.find((target) => key.startsWith(`${target.targetId}.`));
}

function syntheticProviderUrl(value: string, target: NativeTarget): URL | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    return undefined;
  }
  const patterns = SYNTHETIC_HTTP_HOSTS[target.provider];
  return patterns?.some((pattern) => pattern.test(url.hostname)) ? url : undefined;
}

/**
 * Replace only Simulator-owned provider HTTP outputs with the local token-injecting route.
 * Resource IDs, credentials, external URLs, console URLs, and workload loopback URLs stay intact.
 */
export function rewriteSimulatorDataPlaneOutputs(
  problem: SimulatedCloudProblem,
  outputs: Readonly<Record<string, string>>,
  targetOrigin: (targetId: string) => string,
): Readonly<Record<string, string>> {
  const validatedBase = (value: string): URL => {
    const base = new URL(value);
    if (
      (base.protocol !== "http:" && base.protocol !== "https:") ||
      !["127.0.0.1", "localhost", "[::1]", "::1"].includes(base.hostname) ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash
    ) {
      throw new Error("Simulator data-plane proxy base URL must be a loopback origin");
    }
    return base;
  };
  return Object.fromEntries(
    Object.entries(outputs).map(([key, value]) => {
      const target = targetForOutput(problem, key);
      const providerUrl = target ? syntheticProviderUrl(value, target) : undefined;
      if (!target || !providerUrl) return [key, value];
      const base = validatedBase(targetOrigin(target.targetId));
      return [key, new URL(`${providerUrl.pathname}${providerUrl.search}`, base).toString()];
    }),
  );
}
