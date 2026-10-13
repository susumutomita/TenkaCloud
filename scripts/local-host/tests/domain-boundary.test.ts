import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertPortableDomain } from "../../quality/portable-domain";

test("domain runtime closure has no concrete Bun or AWS dependencies", () => {
  expect(assertPortableDomain(resolve(import.meta.dir, "../../.."))).toContain(
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
])("a mistaken helper/provider edit is rejected: %s", (source) => {
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
    expect(() => assertPortableDomain(root, ["scripts/local-host/hosting-domain.ts"])).toThrow(
      "Portable domain",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
