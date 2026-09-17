import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const APPS = ["application-admin-console", "participant-portal"] as const;

/** Output of each app's `vite.host.config.ts`; `main.ts` serves `host.html` from here. */
export function hostBuildDirectory(repositoryRoot: string, app: (typeof APPS)[number]): string {
  return join(repositoryRoot, ".tenkacloud/host-build", app);
}

export async function buildHosting(repositoryRoot: string): Promise<void> {
  for (const app of APPS) {
    await new Promise<void>((accept, reject) => {
      // Same pipeline as the app's own `vite build`, only with the host entry and output.
      const child = spawn(
        process.execPath,
        ["run", "vite", "build", "--config", "vite.host.config.ts"],
        {
          cwd: join(repositoryRoot, "apps", app),
          stdio: "inherit",
        },
      );
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? accept()
          : reject(
              new Error(
                `Local-host ${app} build failed with exit ${String(code)}. Run bun install first.`,
              ),
            ),
      );
    });
    // A build that exits 0 without emitting the entry page is still a failed build.
    if (!existsSync(join(hostBuildDirectory(repositoryRoot, app), "host.html")))
      throw new Error(`Local-host ${app} build produced no host.html.`);
  }
}
