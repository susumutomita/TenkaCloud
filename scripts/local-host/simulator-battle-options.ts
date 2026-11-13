import { isAbsolute, normalize } from "node:path";
import type { OwnedSimulatorLaunchOptions } from "./simulator-owned-launch";

export interface BattleCLIValues {
  "simulator-battle-config"?: string;
  "simulator-battle-config-sha256"?: string;
  "simulator-binary-sha256"?: string;
  "simulator-binary"?: string;
  "no-simulator"?: boolean;
  "update-simulator"?: boolean;
  "behind-proxy"?: boolean;
}

/** Selects existing pinned launch only; never opens files or qualifies a VM. */
export function battleCLIOptions(
  values: BattleCLIValues,
  localManaged: boolean,
  externalSimulator = false,
): OwnedSimulatorLaunchOptions | undefined {
  const path = values["simulator-battle-config"];
  const configHash = values["simulator-battle-config-sha256"];
  const binaryHash = values["simulator-binary-sha256"];
  if (path === undefined && configHash === undefined && binaryHash === undefined) return undefined;
  if (
    !localManaged ||
    externalSimulator ||
    values["no-simulator"] ||
    values["update-simulator"] ||
    values["behind-proxy"]
  )
    throw new Error(
      "Pinned Battle requires same-machine loopback startup without automatic update.",
    );
  const binary = values["simulator-binary"];
  if (
    !path ||
    !binary ||
    !isAbsolute(path) ||
    normalize(path) !== path ||
    !isAbsolute(binary) ||
    normalize(binary) !== binary
  )
    throw new Error(
      "Pinned Battle requires explicit canonical absolute binary and configuration paths.",
    );
  if (!validHash(configHash) || !validHash(binaryHash))
    throw new Error(
      "Pinned Battle requires both lowercase SHA256 pins (binary and configuration).",
    );
  return {
    binarySha256: binaryHash,
    runtimeConfigPath: path,
    runtimeConfigSha256: configHash,
  };
}

function validHash(value: string | undefined): value is string {
  return value !== undefined && /^[a-f0-9]{64}$/u.test(value);
}
