import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const APPS = {
  "application-admin-console": "host console",
  "participant-portal": "participant portal",
} as const;
type App = keyof typeof APPS;

/** `full` streams Vite's report; `summary` prints one line per app and the report only on failure. */
export type BuildOutput = "full" | "summary";

/** Output of each app's `vite.host.config.ts`; `main.ts` serves `host.html` from here. */
export function hostBuildDirectory(repositoryRoot: string, app: App): string {
  return join(repositoryRoot, ".tenkacloud/host-build", app);
}

/** Runs Bun with `args`; in `summary` mode the child's stdout and stderr are returned, not shown. */
export function runBuildCommand(
  args: string[],
  cwd: string,
  output: BuildOutput,
): Promise<{ code: number | null; report: string }> {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: output === "full" ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => accept({ code, report: Buffer.concat(chunks).toString() }));
  });
}

export async function buildHosting(
  repositoryRoot: string,
  output: BuildOutput = "full",
): Promise<void> {
  const { materializeCatalog } = await import("../problem-pack/downloaded-catalog");
  materializeCatalog(repositoryRoot);
  const catalogLock = join(repositoryRoot, ".tenkacloud/catalog-store/selected.json");
  const catalogIdentity = readFileSync(catalogLock, "utf8");
  const apps = Object.keys(APPS) as App[];
  for (const [index, app] of apps.entries()) {
    const started = performance.now();
    if (output === "summary")
      console.log(`Building the ${APPS[app]} (${String(index + 1)}/${String(apps.length)})...`);
    // Same pipeline as the app's own `vite build`, only with the host entry and output.
    const { code, report } = await runBuildCommand(
      ["run", "vite", "build", "--config", "vite.host.config.ts"],
      join(repositoryRoot, "apps", app),
      output,
    );
    if (code !== 0) {
      process.stderr.write(report);
      throw new Error(
        `Local-host ${app} build failed with exit ${String(code)}. Run bun install first.`,
      );
    }
    // A build that exits 0 without emitting the entry page is still a failed build.
    if (!existsSync(join(hostBuildDirectory(repositoryRoot, app), "host.html")))
      throw new Error(`Local-host ${app} build produced no host.html.`);
    if (output === "summary")
      console.log(
        `Built the ${APPS[app]} in ${((performance.now() - started) / 1000).toFixed(1)}s.`,
      );
  }
  if (readFileSync(catalogLock, "utf8") !== catalogIdentity)
    throw new Error("Catalog selection changed during the build; rebuild before starting");
  writeFileSync(
    join(repositoryRoot, ".tenkacloud/host-build/catalog-selection.json"),
    catalogIdentity,
  );
}
