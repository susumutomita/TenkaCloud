import { expect, it } from "bun:test";
import { systemCloudIo } from "./process";

it("captures the actual subprocess upload receipt while streaming output", async () => {
  const result = await systemCloudIo().run({
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write('SOURCE_UPLOAD_VERSION_ID=synthetic-version\\n'); process.stderr.write('synthetic build progress\\n')",
    ],
    cwd: process.cwd(),
    env: process.env,
    inherit: true,
    captureOutput: true,
  });
  expect(result).toEqual({
    code: 0,
    stdout: "SOURCE_UPLOAD_VERSION_ID=synthetic-version\n",
    stderr: "synthetic build progress\n",
  });
});
