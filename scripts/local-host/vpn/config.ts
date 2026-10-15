import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { type VpnPeerPlan, vpnPeerPlan } from "./peer-plan";

/** Registration is an authorization policy. Read an administrator-owned regular file, never keys. */
export function loadVpnPeerPlan(path: string): VpnPeerPlan {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.uid !== 0 || (file.mode & 0o022) !== 0 || file.size > 1024 * 1024)
      throw new Error(
        "VPN registration must be a root-owned regular file, at most 1 MiB, without group/other writes.",
      );
    return vpnPeerPlan(JSON.parse(readFileSync(fd, "utf8")) as unknown);
  } finally {
    closeSync(fd);
  }
}
