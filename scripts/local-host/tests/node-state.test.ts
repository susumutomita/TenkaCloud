import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomToken } from "../auth";
import { persistentKey, prepareDatabase, privateDirectory } from "../files";
import { HostStore } from "../store";

const root = fileURLToPath(new URL("../../../", import.meta.url));
test("Node and Bun preserve the same SQLite event/session/key state and opaque legacy password hashes", async () => {
  const directory = privateDirectory(mkdtempSync(join(tmpdir(), "tenkacloud-node-state-")));
  const path = join(directory, "hosting.sqlite");
  prepareDatabase(path);
  persistentKey(join(directory, "host-key"));
  const hash = await Bun.password.hash(randomToken(), { algorithm: "argon2id" });
  let store = new HostStore(new Database(path, { strict: true }));
  const { key } = store.ensureLocalOrganizerKey();
  store.insertOrganizer({
    id: "preserved-admin",
    username: "preserved-admin",
    role: "Admin",
    status: "active",
    authVersion: 1,
    passwordHash: hash,
    createdAt: 1,
  });
  store.close();
  try {
    const build = spawnSync(process.execPath, ["run", "scripts/local-host/build-node.ts"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(build.status).toBe(0);
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- CI installs the pinned Node24 runtime; private fixture input stays off argv/logs.
    const result = spawnSync("node", [join(root, ".tenkacloud/node-host/state.mjs"), directory], {
      cwd: root,
      encoding: "utf8",
      input: JSON.stringify({ key }),
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("durable restart PASS");
    store = new HostStore(new Database(path, { strict: true }));
    try {
      expect(store.organizerByUsername("preserved-admin")?.passwordHash).toBe(hash);
      expect(store.events().map((event) => event.name)).toContain("Node persistent event");
      expect(store.events().find((event) => event.name === "Node persistent event")?.status).toBe(
        "ARCHIVED",
      );
      expect(store.verifyLocalOrganizerKey(key ?? "")).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
