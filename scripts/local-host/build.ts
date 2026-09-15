import { spawn } from "node:child_process";
import { join } from "node:path";

export async function buildHosting(repositoryRoot: string): Promise<void> {
  for (const app of ["application-admin-console", "participant-portal"]) {
    await new Promise<void>((accept, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--bun",
          "--cwd",
          join(repositoryRoot, "apps", app),
          "run",
          "vite",
          "build",
          "--config",
          "vite.host.config.ts"
        ],
        {
          cwd: repositoryRoot, stdio: "inherit",
        }
      );
      child.once("error", reject);
      child.once(
        "close",
        code => code === 0 ? accept() : reject(new Error(`Local-host ${app} build failed with exit ${String(code)}. Run bun install first.`))
      );
    });
  }
}
