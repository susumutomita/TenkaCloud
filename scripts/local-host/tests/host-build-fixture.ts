import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildHosting, hostBuildDirectory } from "../build";

const builds = new Map<string, Promise<void>>();

/** Production-process tests need the actual interfaces before using --no-build. */
export function ensureHostBuild(root: string): Promise<void> {
  const pending = builds.get(root);
  if (pending) return pending;
  const preparation = (async () => {
    const marker = join(root, ".tenkacloud/host-build/catalog-selection.json");
    const selection = join(root, ".tenkacloud/catalog-store/selected.json");
    const complete = ["application-admin-console", "participant-portal"] as const;
    if (
      existsSync(marker) &&
      readFileSync(marker, "utf8") === readFileSync(selection, "utf8") &&
      complete.every((app) => existsSync(join(hostBuildDirectory(root, app), "host.html")))
    )
      return;
    await buildHosting(root, "summary");
  })();
  builds.set(root, preparation);
  return preparation;
}
