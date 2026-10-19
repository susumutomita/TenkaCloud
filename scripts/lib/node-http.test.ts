import { expect, test } from "bun:test";
import { type ExecFileException, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Kill and reap the child before Bun's enclosing 5-second test deadline. */
function runNode(args: readonly string[], timeout = 3_000) {
  return new Promise<{
    error: ExecFileException | null;
    stdout: string;
    stderr: string;
    status: number | null;
  }>((resolve) => {
    execFile(
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- verify the real Node toolchain required by mise.toml and CI.
      "node",
      [...args],
      { encoding: "utf8", timeout, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        let status: number | null = null;
        if (!error) status = 0;
        else if (typeof error.code === "number") status = error.code;
        resolve({
          error,
          stdout,
          stderr,
          status,
        });
      },
    );
  });
}

test("portable transport starts under Node 24 at AWS_LAMBDA_HTTP_ENDPOINT and survives errors/restart", async () => {
  const result = await runNode([
    fileURLToPath(new URL("./node-http.test-helpers.ts", import.meta.url)),
  ]);
  expect(result.error).toBeNull();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    "Node 24 HTTP transport, endpoint, concurrency, error, bind failure and restart: PASS",
  );
});

test("a stuck Node child is killed and reaped before the enclosing test timeout", async () => {
  const result = await runNode(
    [
      "-e",
      "process.on('SIGTERM', () => {}); process.stdout.write(String(process.pid)); setInterval(() => {}, 1000);",
    ],
    1_000,
  );
  expect(result.error?.killed).toBe(true);
  expect(result.error?.signal).toBe("SIGKILL");
  const pid = Number(result.stdout);
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
});

test("Node failures preserve the exit status and stderr", async () => {
  const result = await runNode([
    "-e",
    "process.stderr.write('transport failed'); process.exit(7);",
  ]);
  expect(result.error).not.toBeNull();
  expect(result.status).toBe(7);
  expect(result.stderr).toBe("transport failed");
});
