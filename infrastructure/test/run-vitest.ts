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

const DEFAULT_MAX_WORKERS = "2";
const DEFAULT_TEST_TIMEOUT_MS = "120000";

function hasCliOption(args: string[], option: string): boolean {
  return args.some((arg) => arg === option || arg.startsWith(`${option}=`));
}

export function buildVitestArgs(
  args = process.argv.slice(2),
  env: Pick<
    NodeJS.ProcessEnv,
    "TENKACLOUD_VITEST_MAX_WORKERS" | "TENKACLOUD_VITEST_TEST_TIMEOUT_MS"
  > = process.env,
): string[] {
  const defaults: string[] = [];

  if (!hasCliOption(args, "--maxWorkers")) {
    defaults.push(`--maxWorkers=${env.TENKACLOUD_VITEST_MAX_WORKERS ?? DEFAULT_MAX_WORKERS}`);
  }

  if (!hasCliOption(args, "--testTimeout")) {
    defaults.push(
      `--testTimeout=${env.TENKACLOUD_VITEST_TEST_TIMEOUT_MS ?? DEFAULT_TEST_TIMEOUT_MS}`,
    );
  }

  return [...args, ...defaults];
}

export async function runVitest(args = process.argv.slice(2)): Promise<number> {
  cleanCdkTestOutdir();
  const child = spawn("vitest", buildVitestArgs(args), { stdio: "inherit" });
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
