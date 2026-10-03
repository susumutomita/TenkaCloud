import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remapComposeHostPorts } from "../container/port-remap";
import type { DockerDefinition } from "../docker-catalog";
import { clearLocalHistory, type LocalClearIo } from "../local-clear";
import type { Job } from "../model";
import { HostStore } from "../store";

/** Reproduce the pre-marker runner's pinned unit, offset Compose file and seed;
 * use the production teardown engine against a fixture-only Docker executable. */
async function fixture(run: (f: ReturnType<typeof setup>) => Promise<void>) {
  const f = setup();
  const previous = {
    PATH: process.env.PATH,
    TENKACLOUD_COMPOSE_CLI: process.env.TENKACLOUD_COMPOSE_CLI,
    TENKA_TEST_DOCKER_CALLS: process.env.TENKA_TEST_DOCKER_CALLS,
    TENKA_TEST_DOCKER_FAIL: process.env.TENKA_TEST_DOCKER_FAIL,
  };
  process.env.PATH = `${join(f.root, "bin")}:${previous.PATH ?? ""}`;
  process.env.TENKACLOUD_COMPOSE_CLI = "docker compose";
  process.env.TENKA_TEST_DOCKER_CALLS = f.callsPath;
  process.env.TENKA_TEST_DOCKER_FAIL = f.failurePath;
  try {
    await run(f);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    fs.rmSync(f.root, { recursive: true, force: true });
  }
}

function setup() {
  const root = fs.mkdtempSync(join(tmpdir(), "tenka-clear-legacy-synthetic-"));
  const data = join(root, "data");
  const catalog = join(root, "catalog");
  const problemDir = join(root, "problem");
  for (const directory of [data, catalog, problemDir, join(root, "bin"), join(catalog, "problems")])
    fs.mkdirSync(directory, { mode: 0o700 });
  const callsPath = join(root, "docker-calls");
  const failurePath = join(root, "docker-failure");
  fs.writeFileSync(
    join(root, "bin", "docker"),
    `#!/bin/sh
case " $* " in
  *" down "*) printf '%s\\n' "$*" >> "$TENKA_TEST_DOCKER_CALLS"
    if [ -f "$TENKA_TEST_DOCKER_FAIL" ]; then exit 1; fi ;;
esac
exit 0
`,
    { mode: 0o700 },
  );
  const sourceCompose =
    'services:\n  app:\n    image: alpine:3.21\n    ports: ["127.0.0.1:18080:8080"]\n    volumes: ["work:/work"]\nvolumes:\n  work: {}\n';
  const definition: DockerDefinition = {
    composeText: sourceCompose,
    hashes: {},
    problem: {
      problemId: "old-problem",
      name: "Old generated fixture",
      description: "Synthetic",
      instructions: "Synthetic",
      problemDir,
      composePath: join(problemDir, "compose.yml"),
      composeProjectName: "tc-local-old-problem",
      challengeEndpoints: { web: "http://127.0.0.1:18080" },
      verifyUrl: "http://127.0.0.1:18080/verify",
      secretEnv: ["FLAG_SEED"],
      scoring: { kind: "verify", points: 10, wrongAnswerPenalty: 0, hints: [] },
    },
  };
  fs.mkdirSync(join(data, "runtimes"), { mode: 0o700 });
  const runtime = join(data, "runtimes", "old-job");
  fs.mkdirSync(runtime, { mode: 0o700 });
  const compose = join(runtime, "tch-old-job.compose.yml");
  const seed = join(runtime, "problem-secrets.key");
  // These are exactly the old generated names and formats. There is deliberately no marker.
  fs.writeFileSync(compose, remapComposeHostPorts(sourceCompose, 1000).text, { mode: 0o600 });
  fs.writeFileSync(seed, `${"1".repeat(64)}\n`, { mode: 0o600 });
  const job: Job = {
    jobId: "old-job",
    eventId: "old-event",
    teamId: "old-team",
    problemId: "old-problem",
    definition: JSON.stringify(definition),
    offset: 1000,
    status: "STOPPED",
    unit: JSON.stringify({
      problemId: "old-problem",
      offset: 1000,
      composePath: compose,
      composeProjectName: "tch-old-job",
      secretEnv: ["FLAG_SEED"],
      projectDirectory: problemDir,
      remappedComposePath: compose,
    }),
  };
  const databasePath = join(data, "hosting.sqlite");
  const open = () => new HostStore(new Database(databasePath));
  const store = open();
  store.putEvent({
    eventId: job.eventId,
    name: "Retained old event",
    status: "ENDED",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    expiresAt: 2_000_000_000,
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems: [],
  });
  store.putTeam({
    eventId: job.eventId,
    teamId: job.teamId,
    internalSlug: "old",
    displayName: "Old",
    loginKey: "fixture-old-participant-key",
    snapshot: null,
    score: 9,
    completedProblems: 1,
    scoreEvents: [],
  });
  store.putJob(job);
  store.close();
  const messages: string[] = [];
  const io: LocalClearIo = {
    write: (message) => messages.push(message),
    confirm: async () => true,
  };
  const calls = () =>
    fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8").trim().split("\n") : [];
  const clear = () => clearLocalHistory(catalog, data, { plan: false, yes: false }, io);
  return {
    root,
    catalog,
    data,
    databasePath,
    runtime,
    compose,
    seed,
    job,
    open,
    callsPath,
    failurePath,
    calls,
    clear,
    io,
    messages,
  };
}

test("clear accepts the actual old generated layout after displaying every legacy target", async () =>
  fixture(async (f) => {
    f.io.confirm = async () => {
      expect(f.messages.join("\n")).toContain(f.compose);
      expect(f.messages.join("\n")).toContain(f.seed);
      expect(f.messages.join("\n")).toContain("legacy generated runtime directory");
      expect(fs.existsSync(join(f.runtime, ".tenkacloud-runtime-owner"))).toBe(false);
      expect(f.calls()).toEqual([]);
      return true;
    };
    await f.clear();
    expect(f.calls()).toHaveLength(1);
    expect(f.calls()[0]).toContain("-p tch-old-job");
    expect(f.calls()[0]).toContain("down --volumes --remove-orphans");
    expect(fs.existsSync(f.runtime)).toBe(false);
    expect(f.messages.join("\n")).not.toContain("1".repeat(64));
    const store = f.open();
    try {
      expect(store.events()).toEqual([]);
    } finally {
      store.close();
    }
  }));

for (const remainder of ["seed", "empty"] as const) {
  test(`clear resumes a known old DELETED job with ${remainder} remainder without Docker`, async () =>
    fixture(async (f) => {
      const store = f.open();
      store.putJob({ ...f.job, status: "DELETED", unit: null });
      store.close();
      fs.unlinkSync(f.compose);
      if (remainder === "empty") fs.unlinkSync(f.seed);
      await f.clear();
      expect(f.calls()).toEqual([]);
      expect(fs.existsSync(f.runtime)).toBe(false);
    }));
}

test("legacy interruption before ownership update recreates only its missing verified Compose plan", async () =>
  fixture(async (f) => {
    fs.unlinkSync(f.compose);
    await f.clear();
    expect(f.calls()).toHaveLength(1);
    expect(fs.existsSync(f.runtime)).toBe(false);
  }));

function updateJob(f: ReturnType<typeof setup>, patch: Partial<Job>): void {
  const store = f.open();
  try {
    store.putJob({ ...f.job, ...patch });
  } finally {
    store.close();
  }
}

const legacyFaults: Record<string, (f: ReturnType<typeof setup>) => void> = {
  compose: (f) => fs.writeFileSync(f.compose, "changed plan"),
  unit: (f) =>
    updateJob(f, {
      unit: JSON.stringify({
        ...(JSON.parse(f.job.unit ?? "{}") as { composeProjectName: string }),
        composeProjectName: "somebody-else",
      }),
    }),
  "deleted with compose": (f) => updateJob(f, { status: "DELETED", unit: null }),
  "unknown file": (f) => fs.writeFileSync(join(f.runtime, "user-work"), "keep"),
  "seed symlink": (f) => {
    fs.unlinkSync(f.seed);
    fs.symlinkSync(f.databasePath, f.seed);
  },
  "seed hardlink": (f) => fs.linkSync(f.seed, join(f.root, "other-seed-link")),
  "unowned seed": (f) => {
    updateJob(f, { status: "FAILED", unit: null });
    fs.unlinkSync(f.compose);
  },
};

for (const [failure, damage] of Object.entries(legacyFaults)) {
  test(`legacy ${failure} refuses without destructive Docker calls and retains history`, async () =>
    fixture(async (f) => {
      damage(f);
      const before = fs.readFileSync(f.databasePath);
      await expect(f.clear()).rejects.toThrow();
      expect(f.calls()).toEqual([]);
      expect(fs.readFileSync(f.databasePath)).toEqual(before);
      expect(fs.existsSync(f.seed)).toBe(true);
    }));
}

test("a legacy file replaced with a symlink during confirmation is refused before Docker", async () =>
  fixture(async (f) => {
    f.io.confirm = async () => {
      fs.unlinkSync(f.seed);
      fs.symlinkSync(f.databasePath, f.seed);
      return true;
    };
    const before = fs.readFileSync(f.databasePath);
    await expect(f.clear()).rejects.toThrow("Unsafe runtime file");
    expect(f.calls()).toEqual([]);
    expect(fs.readFileSync(f.databasePath)).toEqual(before);
  }));

test("failed legacy Docker teardown retains the full unit and retries production validation", async () =>
  fixture(async (f) => {
    fs.writeFileSync(f.failurePath, "fail this synthetic Docker command");
    await expect(f.clear()).rejects.toThrow("all event/history rows are retained");
    const store = f.open();
    try {
      expect(store.job(f.job.jobId).unit).toBe(f.job.unit);
      expect(store.events()).toHaveLength(1);
    } finally {
      store.close();
    }
    expect(fs.existsSync(f.compose)).toBe(true);
    expect(fs.existsSync(f.seed)).toBe(true);
    fs.unlinkSync(f.failurePath);
    await f.clear();
    expect(f.calls()).toHaveLength(2);
    expect(fs.existsSync(f.runtime)).toBe(false);
  }));

for (const stage of ["seed unlink", "directory removal"] as const) {
  test(`legacy ${stage} failure keeps DELETED ownership and resumes without repeating Docker`, async () =>
    fixture(async (f) => {
      const unlink = fs.unlinkSync;
      const rmdir = fs.rmdirSync;
      const refuseUnlink = spyOn(fs, "unlinkSync").mockImplementation(
        (...args: Parameters<typeof fs.unlinkSync>) => {
          if (stage === "seed unlink" && String(args[0]) === f.seed)
            throw new Error("Synthetic seed unlink failure");
          return unlink(...args);
        },
      );
      const refuseRmdir = spyOn(fs, "rmdirSync").mockImplementation(
        (...args: Parameters<typeof fs.rmdirSync>) => {
          if (stage === "directory removal" && String(args[0]) === f.runtime)
            throw new Error("Synthetic directory removal failure");
          return rmdir(...args);
        },
      );
      try {
        await expect(f.clear()).rejects.toThrow("Synthetic");
      } finally {
        refuseUnlink.mockRestore();
        refuseRmdir.mockRestore();
      }
      expect(f.calls()).toHaveLength(1);
      expect(fs.existsSync(f.compose)).toBe(false);
      expect(fs.existsSync(f.seed)).toBe(stage === "seed unlink");
      const store = f.open();
      try {
        expect(store.job(f.job.jobId)).toMatchObject({ status: "DELETED", unit: null });
        expect(store.team(f.job.teamId).score).toBe(9);
        expect(store.events()).toHaveLength(1);
      } finally {
        store.close();
      }
      await f.clear();
      expect(f.calls()).toHaveLength(1);
      expect(fs.existsSync(f.runtime)).toBe(false);
    }));
}
