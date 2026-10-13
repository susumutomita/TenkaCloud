import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { stop } from "esbuild";
import { CompetitionEngine } from "../competition-engine";
import { type HttpHost, startHttpHost } from "../http";
import { localDatabaseOpener } from "../local-database";
import { HostingService } from "../service";
import { HostStore } from "../store";

// Native Node24 organizer and real SQLite; the parent is a separate participant process.
const [directory, catalogPath] = process.argv.slice(2);
assert.ok(directory && catalogPath);
const open = await localDatabaseOpener();
let clock = Date.parse("2026-10-15T10:00:00Z");
let store: HostStore;
let service!: HostingService;
let admin: HttpHost;
let participant: HttpHost;
async function attach() {
  store = new HostStore(open(join(directory ?? "", "hosting.sqlite")));
  const { key } = store.ensureLocalOrganizerKey();
  if (key) writeSync(3, `${key}\n`);
  service = new HostingService(
    store,
    new CompetitionEngine(process.cwd(), directory ?? "", false, undefined, undefined, catalogPath),
    "test-study-master-key",
    () => clock,
  );
  admin = await startHttpHost({
    kind: "admin",
    hostname: "127.0.0.1",
    port: 0,
    staticRoot: directory ?? "",
    service,
  });
  participant = await startHttpHost({
    kind: "participant",
    hostname: "127.0.0.1",
    port: 0,
    staticRoot: directory ?? "",
    service,
  });
  await service.recover();
  await service.drain();
  console.log(JSON.stringify({ admin: admin.origin, participant: participant.origin }));
}
async function detach() {
  await Promise.all([admin.close(), participant.close()]);
  await service.drain();
  store.close();
}
try {
  await attach();
  for await (const line of createInterface({ input: process.stdin })) {
    const command = JSON.parse(line) as { kind: string; now?: number };
    if (command.kind === "restart") {
      await detach();
      await attach();
    } else if (command.kind === "clock" && command.now !== undefined) {
      clock = command.now;
      console.log(JSON.stringify({ now: clock }));
    } else if (command.kind === "drain") {
      await service.drain();
      console.log(JSON.stringify({ drained: true }));
    } else if (command.kind === "stop") break;
    else throw new Error("Unknown study fixture command.");
  }
} finally {
  await detach();
  await stop();
}
