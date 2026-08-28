import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertComposePolicy,
  ComposePolicyError,
  type ContainmentFs,
  checkComposePolicy,
  resolveComposeEntryPath,
  resolveContainedPath,
} from "./compose-policy";

/**
 * [Issue #3097 / ADR-0003 §12] Security regression tests for the Phase A Compose policy
 * validator. Same co-location convention as `problem-secrets.test.ts`: a pure `bun:test` file
 * next to the module it tests, no fs mocking beyond a plain object literal.
 *
 * Two concerns are pinned here:
 *  1. Every dangerous fixture ADR-0003 §12 lists must fail closed with the expected rule.
 *  2. The full current catalog (`problems/` submodule) must pass with zero violations — this is
 *     the "don't break the existing catalog" half of the contract, checked against real files
 *     rather than a fixture that could drift from what problem authors actually ship.
 */

const PROBLEM_DIR = "/p/hello-world";
const COMPOSE_PATH = `${PROBLEM_DIR}/local/docker-compose.yml`;
const CONTEXT = { problemDir: PROBLEM_DIR, composePath: COMPOSE_PATH };

function rulesFor(text: string): string[] {
  return checkComposePolicy(text, CONTEXT).map((v) => v.rule);
}

describe("compose-policy: dangerous fixtures fail closed (ADR-0003 §12)", () => {
  it("privileged-true: privileged denied", () => {
    expect(
      rulesFor(`
services:
  app:
    image: alpine
    privileged: true
`),
    ).toContain("privileged");
  });

  it("docker-socket-bind: runtime socket / host bind denied", () => {
    expect(
      rulesFor(`
services:
  app:
    image: alpine
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`),
    ).toContain("docker-socket-bind");
  });

  it("host-root-bind: problem directory外 source denied", () => {
    expect(
      rulesFor(`
services:
  app:
    image: alpine
    volumes:
      - ../../../../etc:/mnt/etc
`),
    ).toContain("host-bind-mount");
  });

  it("device-pass-through: devices denied", () => {
    expect(
      rulesFor(`
services:
  app:
    image: alpine
    devices:
      - /dev/sda:/dev/sda
`),
    ).toContain("device");
  });

  it("cap-sys-admin: cap_add denied", () => {
    expect(
      rulesFor(`
services:
  app:
    image: alpine
    cap_add: [SYS_ADMIN]
`),
    ).toContain("cap-add");
  });

  it("host-pid-ipc-network: host namespace denied (pid)", () => {
    expect(
      rulesFor(`
services:
  app:
    image: alpine
    pid: host
`),
    ).toContain("host-namespace");
  });

  it("host-pid-ipc-network: host namespace denied (ipc)", () => {
    expect(
      rulesFor(`
services:
  app:
    image: alpine
    ipc: host
`),
    ).toContain("host-namespace");
  });

  it("host-pid-ipc-network: host namespace denied (network_mode: host)", () => {
    expect(
      rulesFor(`
services:
  app:
    image: alpine
    network_mode: host
`),
    ).toContain("host-namespace");
  });

  it("unconfined-security-profile: seccomp=unconfined denied", () => {
    expect(
      rulesFor(`
services:
  app:
    image: alpine
    security_opt:
      - seccomp=unconfined
`),
    ).toContain("unconfined-security-profile");
  });

  it("unconfined-security-profile: no-new-privileges:false denied", () => {
    expect(
      rulesFor(`
services:
  app:
    image: alpine
    security_opt:
      - no-new-privileges:false
`),
    ).toContain("unconfined-security-profile");
  });

  it("unconfined-security-profile: an out-of-bounds seccomp profile file denied", () => {
    expect(
      rulesFor(`
services:
  app:
    image: alpine
    security_opt:
      - seccomp=../../../etc/malicious-profile.json
`),
    ).toContain("unconfined-security-profile");
  });

  it("wildcard-publish: 0.0.0.0 publish denied", () => {
    expect(
      rulesFor(`
services:
  app:
    image: alpine
    ports:
      - "0.0.0.0:8080:8080"
`),
    ).toContain("wildcard-publish");
  });

  it("wildcard-publish: bare host:container form (no explicit loopback IP) denied", () => {
    expect(
      rulesFor(`
services:
  app:
    image: alpine
    ports:
      - "8080:8080"
`),
    ).toContain("wildcard-publish");
  });

  it("external-network-volume: an externally-owned named volume denied", () => {
    expect(
      rulesFor(`
volumes:
  data:
    external: true
services:
  app:
    image: alpine
    volumes:
      - data:/var/lib/data
`),
    ).toContain("external-network-or-volume");
  });

  it("external-network-volume: a driver_opts bind-mount-disguised-as-volume denied", () => {
    expect(
      rulesFor(`
volumes:
  data:
    driver_opts:
      type: none
      o: bind
      device: /etc
services:
  app:
    image: alpine
    volumes:
      - data:/mnt
`),
    ).toContain("external-network-or-volume");
  });

  it("external-network-volume: a host-driver network denied", () => {
    expect(
      rulesFor(`
networks:
  bad:
    driver: host
services:
  app:
    image: alpine
    networks: [bad]
`),
    ).toContain("host-namespace");
  });

  it("build-context-escape: a build context outside the problem directory denied", () => {
    expect(
      rulesFor(`
services:
  app:
    build:
      context: ../../../../etc
`),
    ).toContain("build-context-escape");
  });

  it("build-context-escape: a Dockerfile escaping its own build context denied", () => {
    expect(
      rulesFor(`
services:
  app:
    build:
      context: .
      dockerfile: ../../../etc/passwd
`),
    ).toContain("build-context-escape");
  });

  it("unknown-compose-feature: an unlisted service key denied by omission", () => {
    expect(
      rulesFor(`
services:
  app:
    image: alpine
    command: ["sh", "-c", "echo hi"]
`),
    ).toContain("unknown-compose-feature");
  });

  it("unknown-compose-feature: an unlisted top-level key denied", () => {
    expect(
      rulesFor(`
configs:
  x: {}
services:
  app:
    image: alpine
`),
    ).toContain("unknown-compose-feature");
  });

  it("reports every violation at once, not just the first", () => {
    const violations = checkComposePolicy(
      `
services:
  app:
    image: alpine
    privileged: true
    cap_add: [SYS_ADMIN]
    ports:
      - "0.0.0.0:8080:8080"
`,
      CONTEXT,
    );
    const rules = violations.map((v) => v.rule);
    expect(rules).toContain("privileged");
    expect(rules).toContain("cap-add");
    expect(rules).toContain("wildcard-publish");
    expect(violations.length).toBeGreaterThanOrEqual(3);
  });
});

describe("compose-policy: assertComposePolicy / ComposePolicyError", () => {
  it("throws a ComposePolicyError carrying the violations for a dangerous compose", () => {
    expect(() =>
      assertComposePolicy(
        `
services:
  app:
    image: alpine
    privileged: true
`,
        CONTEXT,
      ),
    ).toThrow(ComposePolicyError);
    try {
      assertComposePolicy(
        `
services:
  app:
    image: alpine
    privileged: true
`,
        CONTEXT,
      );
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(ComposePolicyError);
      expect((error as ComposePolicyError).violations).toEqual([
        expect.objectContaining({ rule: "privileged" }),
      ]);
      expect((error as Error).message).toContain(COMPOSE_PATH);
    }
  });

  it("does not throw for a compliant compose", () => {
    expect(() =>
      assertComposePolicy(
        `
services:
  app:
    image: alpine
    ports:
      - "127.0.0.1:18080:8080"
`,
        CONTEXT,
      ),
    ).not.toThrow();
  });
});

describe("compose-policy: positive fixtures (the shapes real problems use)", () => {
  it("accepts a single service with loopback publish, healthcheck, and cap_drop", () => {
    expect(
      rulesFor(`
name: hello-world
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
      target: participant
    read_only: true
    cap_drop: [ALL]
    security_opt:
      - "no-new-privileges:true"
    tmpfs:
      - "/tmp:rw,noexec,nosuid"
    mem_limit: "256m"
    pids_limit: 64
    cpus: "0.5"
    restart: "no"
    environment:
      FLAG_SEED: "\${FLAG_SEED:?FLAG_SEED must be provided by the platform}"
    ports:
      - "127.0.0.1:18080:8080"
    healthcheck:
      test: ["CMD", "true"]
      interval: "3s"
      timeout: "3s"
      retries: 10
`),
    ).toEqual([]);
  });

  it("accepts a multi-service problem with a one-shot initializer and a named volume", () => {
    expect(
      rulesFor(`
name: hello-multi
services:
  db-init:
    image: alpine
    restart: "no"
    volumes:
      - db_data:/var/lib/mysql
  app:
    build:
      context: .
      dockerfile: Dockerfile
    depends_on:
      db-init:
        condition: service_completed_successfully
    ports:
      - "127.0.0.1:18080:8080"
    healthcheck:
      test: ["CMD", "true"]
      interval: "5s"
      timeout: "5s"
      retries: 20
volumes:
  db_data:
`),
    ).toEqual([]);
  });

  it("accepts a relative volume source and an internal + loopback-bridge network pair", () => {
    expect(
      rulesFor(`
name: hello-lab
networks:
  lab:
    internal: true
  workshop-host:
    driver: bridge
    driver_opts:
      com.docker.network.bridge.enable_ip_masquerade: "false"
      com.docker.network.bridge.host_binding_ipv4: "127.0.0.1"
services:
  workbench:
    build:
      context: .
      target: participant
    volumes:
      - ./solution:/app/solution:ro
    ports:
      - "127.0.0.1:18080:18080"
    networks: [lab, workshop-host]
  verifier:
    build:
      context: .
      target: verifier
    networks: [lab]
`),
    ).toEqual([]);
  });
});

describe("compose-policy: runtime.entry containment (manifest.ts seam)", () => {
  it("rejects a lexical .. traversal", () => {
    expect(() => resolveComposeEntryPath(PROBLEM_DIR, "../../etc/passwd")).toThrow(/escapes/);
  });

  it("rejects an absolute entry", () => {
    expect(() => resolveComposeEntryPath(PROBLEM_DIR, "/etc/passwd")).toThrow(
      /must be a relative path/,
    );
  });

  it("rejects a symlink that resolves outside the problem directory", () => {
    const fs: ContainmentFs = {
      existsSync: (p) => p === COMPOSE_PATH || p === PROBLEM_DIR,
      realpathSync: (p) => (p === COMPOSE_PATH ? "/etc/attacker-controlled.yml" : p),
    };
    expect(() => resolveComposeEntryPath(PROBLEM_DIR, "local/docker-compose.yml", fs)).toThrow(
      /symlink/,
    );
  });

  it('preserves the historical "compose file was not found" message for a missing entry', () => {
    const fs: ContainmentFs = { existsSync: () => false };
    expect(() => resolveComposeEntryPath(PROBLEM_DIR, "local/docker-compose.yml", fs)).toThrow(
      /compose file was not found/,
    );
  });

  it("accepts a normal in-directory entry with no realpath fs injected", () => {
    const fs: ContainmentFs = { existsSync: (p) => p === COMPOSE_PATH };
    expect(resolveComposeEntryPath(PROBLEM_DIR, "local/docker-compose.yml", fs)).toBe(COMPOSE_PATH);
  });
});

describe("compose-policy: resolveContainedPath", () => {
  it("rejects an absolute candidate outright", () => {
    expect(() => resolveContainedPath("label", "/etc/passwd", "/p/x", ["/p/x"])).toThrow(
      /must be a relative path/,
    );
  });

  it("accepts a path that stays within an allowed root", () => {
    expect(resolveContainedPath("label", "./sub/dir", "/p/x", ["/p/x"])).toBe("/p/x/sub/dir");
  });

  it("accepts a second allowed root (the runtimes/ carve-out shape)", () => {
    expect(
      resolveContainedPath(
        "label",
        "../../../runtimes/stackstack",
        "/problems/challenges/x/local",
        ["/problems/challenges/x", "/problems/runtimes"],
      ),
    ).toBe("/problems/runtimes/stackstack");
  });
});

// ---------------------------------------------------------------------------
// Real catalog scan. Skips gracefully (not silently — it prints why) when the `problems/`
// submodule has not been checked out, matching `listLocalPlayProblems`'s own tolerance for an
// absent catalog; `make agent-gate` / CI always initialize the submodule before this runs.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CATALOG_ROOTS = [
  join(REPO_ROOT, "problems", "challenges"),
  join(REPO_ROOT, "problems", "battles"),
];

interface CatalogComposeEntry {
  readonly problemDir: string;
  readonly composePath: string;
}

/** One problem directory's compose entry, or undefined when it is not a compose-engine local-play
 * problem at all (AWS-only, malformed, missing compose file) — mirrors `loadContainerProblem`'s
 * own tolerance for a mixed catalog. */
function composeEntryForProblem(problemDir: string): CatalogComposeEntry | undefined {
  const metadataPath = join(problemDir, "metadata.json");
  if (!existsSync(metadataPath)) return undefined;
  let metadata: { runtime?: { engine?: unknown; entry?: unknown } };
  try {
    metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch {
    return undefined;
  }
  const runtime = metadata.runtime;
  if (typeof runtime !== "object" || runtime === null) return undefined;
  if (runtime.engine !== "compose" || typeof runtime.entry !== "string") return undefined;
  const composePath = join(problemDir, runtime.entry);
  if (!existsSync(composePath)) return undefined;
  return { problemDir, composePath };
}

function discoverCatalogComposeEntries(): readonly CatalogComposeEntry[] {
  const entries: CatalogComposeEntry[] = [];
  for (const root of CATALOG_ROOTS) {
    if (!existsSync(root)) continue;
    for (const problemId of readdirSync(root)) {
      const entry = composeEntryForProblem(join(root, problemId));
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

describe("compose-policy: the real catalog (problems/ submodule)", () => {
  const entries = discoverCatalogComposeEntries();

  if (entries.length === 0) {
    it.skip("problems/ submodule is not checked out — run `git submodule update --init problems`", () => {
      expect(entries.length).toBe(0);
    });
  } else {
    it(`every one of the catalog's ${entries.length} compose-engine problems passes the Phase A policy`, () => {
      const failures: string[] = [];
      for (const entry of entries) {
        const text = readFileSync(entry.composePath, "utf8");
        const violations = checkComposePolicy(text, entry);
        if (violations.length > 0) {
          failures.push(
            `${entry.composePath}:\n` +
              violations.map((v) => `  - [${v.rule}] ${v.message}`).join("\n"),
          );
        }
      }
      expect(failures.join("\n\n")).toBe("");
    });
  }
});
