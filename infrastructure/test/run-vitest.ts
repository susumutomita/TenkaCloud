import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CDK_TEST_OUTDIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "cdk.out.test",
);

export function cleanCdkTestOutdir(outdir = CDK_TEST_OUTDIR): void {
  rmSync(outdir, { force: true, recursive: true });
}

export async function runVitest(args = process.argv.slice(2)): Promise<number> {
  cleanCdkTestOutdir();
  const child = spawn("vitest", args, { stdio: "inherit" });
  const forwardSignal = (signal: NodeJS.Signals) => child.kill(signal);
  const signals: NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGTERM"];

  for (const signal of signals) {
    process.once(signal, forwardSignal);
  }

  try {
    return await new Promise<number>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolveExit(code ?? 1));
    });
  } finally {
    for (const signal of signals) {
      process.off(signal, forwardSignal);
    }
    cleanCdkTestOutdir();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runVitest();
}
