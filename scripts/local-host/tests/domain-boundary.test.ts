import { afterEach, beforeEach, expect, test } from "bun:test";
import { type ChildProcess, fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Import TypeScript before each test's clock starts, as the original module import did.
// Each case then owns a fresh Program, reclaimed with its child before the next fixture.
let checker: ChildProcess;
beforeEach(async () => {
  checker = fork(fileURLToPath(new URL("./domain-boundary.test-helpers.ts", import.meta.url)), [], {
    execPath: process.execPath,
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  await new Promise<void>((resolve, reject) => {
    const exit = () => reject(new Error("Checker exited before initialization."));
    checker.once("exit", exit);
    checker.once("error", reject);
    checker.once("message", (message: { ready?: boolean }) => {
      checker.removeListener("exit", exit);
      if (message.ready) resolve();
      else reject(new Error("Checker did not initialize."));
    });
  });
});
afterEach(async () => {
  if (!checker || checker.exitCode !== null || checker.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    checker.once("exit", () => resolve());
    checker.kill();
  });
});
function assertPortableDomain(root: string, roots?: readonly string[]): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    const exit = () => reject(new Error("Checker exited before validation completed."));
    checker.once("exit", exit);
    checker.once("message", (result: { ok: boolean; files: string[]; error?: string }) => {
      checker.removeListener("exit", exit);
      if (result.ok) resolve(result.files);
      else reject(new Error(result.error));
    });
    checker.send({ root, roots });
  });
}

test("domain runtime closure has no concrete Bun or AWS dependencies", async () => {
  expect(await assertPortableDomain(resolve(import.meta.dir, "../../.."))).toContain(
    "scripts/local-host/participant-aws-contract.ts",
  );
});
test.each([
  "import { Database } from 'bun:sqlite';",
  "import type { SSMClient } from '@aws-sdk/client-ssm';",
  "void import('@aws-sdk/client-sts');",
  "const name = '@aws-sdk/client-sts'; void import(name);",
  "require('@smithy/signature-v4');",
  "Bun.password.verify('input', 'hash');",
  "globalThis['Bun'].password.hash('input');",
  "const principal = {} as OrganizerPrincipal;",
  "import type { OrganizerPrincipal } from './organizer-principal'; type Alias = OrganizerPrincipal; const principal = {} as Alias;",
  "const principal = {} as import('./organizer-principal').OrganizerPrincipal;",
  "import type { OrganizerPrincipal } from './organizer-principal'; const principal: OrganizerPrincipal = JSON.parse('{}');",
  "import type { OrganizerPrincipal } from './organizer-principal'; declare const viewer: OrganizerPrincipal; const principal = {...viewer, role:'Admin' as const};",
])("a mistaken helper/provider edit is rejected: %s", async (source) => {
  const root = mkdtempSync(join(tmpdir(), "portable-domain-"));
  try {
    for (const [file, body] of Object.entries({
      "scripts/local-host/hosting-domain.ts": "import './helper';",
      "scripts/local-host/helper.ts": source,
      "scripts/local-host/organizer-principal.ts":
        "declare const authenticatedOrganizer: unique symbol; export type OrganizerPrincipal = {readonly role: 'Admin'|'Viewer'; readonly [authenticatedOrganizer]: true};",
    })) {
      const path = join(root, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
    }
    await expect(
      assertPortableDomain(root, ["scripts/local-host/hosting-domain.ts"]),
    ).rejects.toThrow("Portable domain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
