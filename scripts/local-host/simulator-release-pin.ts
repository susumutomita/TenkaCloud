import type { SimulatorRelease } from "./simulator-release";

/** Replace only after verifying the published official release and all four asset hashes. */
export function officialSimulatorRelease(): SimulatorRelease {
  throw new Error(
    "The official Simulator binary release has not been pinned in this host version yet. Use --simulator-binary with an existing compatible native executable, configure an external local Simulator, or use --no-simulator for Docker/browser exercises. No source build or real AWS fallback was attempted.",
  );
}
