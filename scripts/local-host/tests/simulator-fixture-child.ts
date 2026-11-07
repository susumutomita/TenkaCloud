import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type FixtureProcess,
  fixtureCommandOutput,
  registerFixtureInterruptCleanup,
  SimulatorFixtureError,
  waitForFixtureOperation,
} from "../integration/simulator-fixture-process";

type ChildMode =
  | "catalog-read-selection"
  | "catalog-copy-selection"
  | "catalog-prepare"
  | "catalog-verify-sources"
  | "catalog-read-lock"
  | "readiness"
  | "orphan-launcher"
  | "orphan-descendant"
  | "shell-descendant"
  | "interrupt-harness"
  | "interrupt-child"
  | "interrupt-descendant";

/** Fixture data stays in argv, never in executable source or a generated import. */
export function simulatorFixtureChild(mode: ChildMode, ...args: string[]): [string, ...string[]] {
  return [process.execPath, fileURLToPath(import.meta.url), mode, ...args];
}

function argument(args: string[], index: number): string {
  const value = args[index];
  if (value === undefined) throw new Error("Missing synthetic child argument.");
  return value;
}

async function rejectCatalog(mode: string, args: string[]): Promise<never> {
  const catalog = await import("../integration/simulator-fixture-catalog");
  try {
    const repository = argument(args, 0);
    switch (mode) {
      case "catalog-read-selection":
        catalog.readFixtureCatalogSelection(repository);
        break;
      case "catalog-copy-selection":
        catalog.copyFixtureSelection(repository, argument(args, 1));
        break;
      case "catalog-prepare":
        catalog.prepareFixtureCatalog(repository, argument(args, 1), argument(args, 2));
        break;
      case "catalog-verify-sources":
        catalog.verifyFixtureSources(repository, argument(args, 1), argument(args, 2));
        break;
      case "catalog-read-lock":
        catalog.readFixtureCatalogLock(repository);
        break;
      default:
        throw new Error("Unknown synthetic catalog operation.");
    }
    process.exit(2);
  } catch (error) {
    process.exit(error instanceof SimulatorFixtureError ? 0 : 3);
  }
}

async function readiness(started: string, closed: string): Promise<void> {
  process.on("SIGTERM", () => {
    writeFileSync(closed, "closed");
    process.exit(0);
  });
  console.log("synthetic-private-secret");
  console.error("synthetic-private-secret");
  writeFileSync(started, "started");
  await Bun.sleep(10_000);
}

async function orphanDescendant(started: string, closed: string): Promise<void> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("alive") });
  process.on("SIGTERM", () => {
    writeFileSync(closed, "closed");
    process.exit(0);
  });
  writeFileSync(started, String(server.port));
  await Bun.sleep(10_000);
}

async function orphanLauncher(started: string, closed: string): Promise<never> {
  const [executable, ...args] = simulatorFixtureChild("orphan-descendant", started, closed);
  const child = spawn(executable, args, { stdio: "ignore" });
  child.unref();
  await Bun.sleep(250);
  process.exit(0);
}

function ignoreTermination(): void {
  process.on("SIGTERM", () => {
    // Require bounded SIGKILL escalation, not graceful child shutdown.
  });
}

async function shellDescendant(ready: string): Promise<void> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("alive") });
  ignoreTermination();
  console.error("synthetic-private-token");
  writeFileSync(ready, JSON.stringify({ port: server.port }));
  await Bun.sleep(60_000);
}

async function interruptDescendant(root: string): Promise<void> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("descendant"),
  });
  writeFileSync(
    join(root, "descendant.json"),
    JSON.stringify({ pid: process.pid, port: server.port }),
  );
  ignoreTermination();
  await Bun.sleep(60_000);
}

async function interruptChild(root: string): Promise<void> {
  const [executable, ...args] = simulatorFixtureChild("interrupt-descendant", root);
  spawn(executable, args, { stdio: "ignore" });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("child") });
  const descendantReady = join(root, "descendant.json");
  while (!existsSync(descendantReady)) await Bun.sleep(10);
  const descendant = JSON.parse(readFileSync(descendantReady, "utf8")) as { port: number };
  writeFileSync(
    join(root, "ready.json"),
    JSON.stringify({ pid: process.pid, port: server.port, descendant: descendant.port }),
  );
  console.error("synthetic-private-token");
  ignoreTermination();
  await Bun.sleep(60_000);
}

async function interruptHarness(root: string): Promise<void> {
  const state = join(root, "private-state");
  const children = new Set<FixtureProcess>();
  let stopping: Promise<void> | undefined;
  const unregister = registerFixtureInterruptCleanup(
    () =>
      (stopping ??= (async () => {
        await Promise.all([...children].map((child) => child.stop()));
        rmSync(state, { recursive: true, force: true });
      })().finally(() => unregister())),
  );
  registerFixtureInterruptCleanup(async () => {
    await Bun.sleep(250);
    writeFileSync(join(root, "all-cleanups-completed"), "completed");
  });
  mkdirSync(state);
  writeFileSync(join(state, "token"), "synthetic-private-token");
  // Interrupt during setup, before a simulator/host handle can be returned.
  await waitForFixtureOperation(
    fixtureCommandOutput(simulatorFixtureChild("interrupt-child", root), {
      cwd: root,
      environment: { PATH: "/usr/bin:/bin", HOME: state },
      onSpawn: (child) => children.add(child),
    }),
  );
  console.log("must not resume after interruption");
}

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2);
  switch (mode) {
    case "catalog-read-selection":
    case "catalog-copy-selection":
    case "catalog-prepare":
    case "catalog-verify-sources":
    case "catalog-read-lock":
      await rejectCatalog(mode, args);
      break;
    case "readiness":
      await readiness(argument(args, 0), argument(args, 1));
      break;
    case "orphan-launcher":
      await orphanLauncher(argument(args, 0), argument(args, 1));
      break;
    case "orphan-descendant":
      await orphanDescendant(argument(args, 0), argument(args, 1));
      break;
    case "shell-descendant":
      await shellDescendant(argument(args, 0));
      break;
    case "interrupt-harness":
      await interruptHarness(argument(args, 0));
      break;
    case "interrupt-child":
      await interruptChild(argument(args, 0));
      break;
    case "interrupt-descendant":
      await interruptDescendant(argument(args, 0));
      break;
    default:
      throw new Error("Unknown synthetic child mode.");
  }
}
