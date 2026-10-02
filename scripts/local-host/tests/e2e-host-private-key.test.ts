import { expect, test } from "bun:test";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { spawnPrivateKeyProcess } from "../private-key-process";
import { inspectTemporaryDirectories } from "../temporary-directory";

const repository = fileURLToPath(new URL("../../../", import.meta.url));

test("browser fixture delivers its login key only over the private pipe", async () => {
  const {
    child,
    stdout: publicOutput,
    stderr: errorOutput,
    privateOutput,
    exited,
  } = spawnPrivateKeyProcess([process.execPath, "run", "scripts/local-host/tests/e2e-host.ts"], {
    cwd: repository,
    env: {
      ...process.env,
      HOST_E2E_ENGINE: "fixture",
      HOST_E2E_ADMIN_PORT: "0",
      HOST_E2E_PARTICIPANT_PORT: "0",
      HOST_E2E_KEY_FD: "3",
    },
  });
  let stdout = "";
  let stderr = "";
  publicOutput.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  errorOutput.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const publicLines = createInterface({ input: publicOutput });
  const privateLines = createInterface({ input: privateOutput });
  const line = (lines: ReturnType<typeof createInterface>) =>
    new Promise<string>((accept, reject) => {
      lines.once("line", accept);
      void child.exited.then(
        () => reject(new Error("Browser fixture exited before readiness.")),
        reject,
      );
    });
  let key = "";
  try {
    const [address, secret] = await Promise.all([line(publicLines), line(privateLines)]);
    key = secret;
    expect(/^[A-Za-z0-9_-]{43}$/u.test(key)).toBe(true);
    const host = JSON.parse(address) as Record<string, unknown>;
    expect(Object.keys(host).sort()).toEqual(["admin", "engine", "participant"]);
    expect(typeof host.admin).toBe("string");
    const login = await fetch(`${String(host.admin)}/api/host/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
    expect(login.status).toBe(200);
    expect(stdout.includes(key)).toBe(false);
    expect(stderr.includes(key)).toBe(false);
  } finally {
    publicLines.close();
    privateLines.close();
    publicOutput.resume();
    privateOutput.resume();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    expect(await exited).toBe(0);
    if (key) {
      expect(stdout.includes(key)).toBe(false);
      expect(stderr.includes(key)).toBe(false);
    }
    expect(
      inspectTemporaryDirectories(repository).some((entry) => entry.ownerPid === child.pid),
    ).toBe(false);
  }
}, 15_000);
