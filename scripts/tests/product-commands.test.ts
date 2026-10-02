import { expect, test } from "bun:test";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
function make(...args: string[]) {
  return spawnSync("/usr/bin/make", ["--no-print-directory", ...args], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
}
test("default bilingual help includes hosting, catalog updates and development commands", () => {
  for (const language of ["en", "ja"]) {
    const result = make("help", `HELP_LANG=${language}`);
    expect(result.status).toBe(0);
    expect([...result.stdout.matchAll(/^ {2}([a-z-]+)\s/gmu)].map((match) => match[1])).toEqual([
      "local",
      "down",
      "local-reset",
      "deploy",
      "destroy",
      "submodule-latest",
      "validate-problems",
      "build",
      "install",
      "test",
      "lint",
      "before-commit",
    ]);
    expect(result.stdout).toContain(language === "ja" ? "開発用" : "Development");
    expect(result.stdout).toContain(
      language === "ja" ? "問題ソース・カタログ更新" : "Problem sources and catalog updates",
    );
    expect(result.stdout).not.toContain("SaaS");
    expect(result.stdout).not.toContain("Phase 1");
    expect(result.stdout).not.toContain("test-root");
  }
});
test("local-reset reaches only key rotation, not shutdown or cloud teardown", () => {
  const result = make("-n", "local-reset", "LOCAL_ARGS=--data /tmp/synthetic-host");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("scripts/local-host/local.ts reset --data /tmp/synthetic-host");
  expect(result.stdout).not.toContain("cloud-hosting");
  expect(result.stdout).not.toContain("local.ts down");
});
test("retired demo and test-root targets are removed without dropping root or security tests", () => {
  for (const target of [
    "local-down",
    "test-root",
    "security-harness-demo",
    "host",
    "saas",
    "deploy-saas",
    "pack-activate",
    "pack-deactivate",
  ])
    expect(make("-n", target).status).not.toBe(0);
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts.test).toContain("bun run test:root");
  expect(pkg.scripts["test:root"]).toContain("./scripts/security/*.test.ts");
  expect(
    readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ).toContain("run: bun run test:root");
  const developer = make("help", "HELP_SCOPE=developer");
  expect(developer.status).toBe(0);
  expect(developer.stdout).toContain("before-commit");
  expect(developer.stdout).not.toContain("security-harness-demo");
});

test("the four development targets retain safe installation and the complete verification path", () => {
  const install = make("-n", "install");
  expect(install.status).toBe(0);
  expect(install.stdout).toContain("bun install --ignore-scripts");
  const tests = make("-n", "test");
  expect(tests.status).toBe(0);
  expect(tests.stdout).toContain("bun run test");
  for (const target of ["lint", "before-commit"]) {
    const result = make("-n", target);
    expect(result.status).toBe(0);
    for (const check of ["lint:md", "lint:text", "lint:format", "lint:eslint-scope", "lint:ts"])
      expect(result.stdout).toContain(`bun run ${check}`);
    if (target === "before-commit") {
      expect(result.stdout).toContain("bun run dead-code");
      expect(result.stdout).toContain("bun run test");
    }
  }
});

interface CatalogFixture {
  catalog: string;
  checkout: string;
  sources: string;
  state: string;
  build: string;
  git: (cwd: string, ...args: string[]) => string;
  update: () => SpawnSyncReturns<string>;
}

function withCatalog(run: (fixture: CatalogFixture) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "tenkacloud-catalog-update-"));
  const catalog = join(directory, "catalog");
  const checkout = join(directory, "platform");
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Catalog test",
    GIT_AUTHOR_EMAIL: "catalog-test@example.invalid",
    GIT_COMMITTER_NAME: "Catalog test",
    GIT_COMMITTER_EMAIL: "catalog-test@example.invalid",
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("/usr/bin/git", ["-c", "commit.gpgsign=false", ...args], {
      cwd,
      env,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    for (const path of [catalog, checkout]) {
      mkdirSync(path);
      git(path, "init", "--initial-branch=main");
    }
    writeFileSync(join(catalog, "README.md"), "Original catalog\n");
    git(catalog, "add", ".");
    git(catalog, "commit", "-m", "Original catalog");
    for (const file of [
      "Makefile",
      "scripts/ops/update-problems.ts",
      "scripts/quality/check-submodule-not-behind.ts",
    ]) {
      mkdirSync(dirname(join(checkout, file)), { recursive: true });
      copyFileSync(join(root, file), join(checkout, file));
    }
    git(checkout, "submodule", "add", catalog, "problems");
    git(checkout, "config", "-f", ".gitmodules", "submodule.problems.branch", "main");
    git(checkout, "add", ".");
    git(checkout, "commit", "-m", "Pinned catalog");
    mkdirSync(join(checkout, ".tenkacloud", "host"), { recursive: true });
    mkdirSync(join(checkout, ".tenkacloud", "host-build"), { recursive: true });
    const state = join(checkout, ".tenkacloud", "host", "hosting.sqlite");
    const build = join(checkout, ".tenkacloud", "host-build", "sentinel.html");
    writeFileSync(state, "Retained event state");
    writeFileSync(build, "Previously built catalog");
    run({
      catalog,
      checkout,
      sources: join(checkout, "problems"),
      state,
      build,
      git,
      update: () =>
        spawnSync("/usr/bin/make", ["--no-print-directory", "submodule-latest"], {
          cwd: checkout,
          env,
          encoding: "utf8",
        }),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("catalog fast-forward/equal updates preserve unrelated staged work and host state", () => {
  withCatalog(({ catalog, checkout, sources, state, build, git, update }) => {
    writeFileSync(join(checkout, "notes.txt"), "Unrelated staged work");
    git(checkout, "add", "notes.txt");
    writeFileSync(join(checkout, "notes.txt"), "Unstaged follow-up work");
    writeFileSync(join(catalog, "README.md"), "Updated catalog\n");
    git(catalog, "commit", "-am", "Updated catalog");
    const expectedPin = git(catalog, "rev-parse", "HEAD");
    for (const expectedMessage of [
      "problems bumped + staged",
      "problems already at the latest pin",
    ]) {
      const result = update();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(expectedMessage);
      expect(result.stdout).toContain("running hosts are not refreshed");
      expect(git(checkout, "rev-parse", ":problems")).toBe(expectedPin);
      expect(git(sources, "rev-parse", "HEAD")).toBe(expectedPin);
      expect(git(checkout, "diff", "--cached", "--name-only")).toBe("notes.txt\nproblems");
      expect(git(checkout, "show", ":notes.txt")).toBe("Unrelated staged work");
      expect(readFileSync(join(checkout, "notes.txt"), "utf8")).toBe("Unstaged follow-up work");
      expect(readFileSync(state, "utf8")).toBe("Retained event state");
      expect(readFileSync(build, "utf8")).toBe("Previously built catalog");
    }
  });
});

function expectRejectedUpdate(fixture: CatalogFixture, error: string): void {
  const { checkout, sources, state, build, git, update } = fixture;
  const pin = git(sources, "rev-parse", "HEAD");
  const files = [
    join(checkout, ".git", "index"),
    join(git(sources, "rev-parse", "--absolute-git-dir"), "index"),
    join(sources, "README.md"),
    state,
    build,
  ];
  const before = files.map((file) => readFileSync(file));
  const result = update();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(error);
  expect(git(sources, "rev-parse", "HEAD")).toBe(pin);
  expect(files.map((file) => readFileSync(file))).toEqual(before);
  expect(result.stdout).not.toContain("bumped + staged");
}

test.each(["ahead", "diverged"])(
  "catalog refuses a %s local pin before checkout or staging",
  (kind) => {
    withCatalog((fixture) => {
      const { catalog, checkout, sources, git } = fixture;
      writeFileSync(join(sources, "README.md"), "Reviewed candidate fix\n");
      git(sources, "commit", "-am", "Reviewed candidate fix");
      git(checkout, "add", "problems");
      if (kind === "diverged") {
        writeFileSync(join(catalog, "README.md"), "Different upstream change\n");
        git(catalog, "commit", "-am", "Different upstream change");
      }
      expectRejectedUpdate(fixture, "Refusing catalog rollback or divergence");
    });
  },
);

test.each(["staged", "unstaged", "untracked"])(
  "catalog refuses %s source work without altering it",
  (kind) => {
    withCatalog((fixture) => {
      const { catalog, sources, git } = fixture;
      writeFileSync(join(catalog, "README.md"), "Upstream update\n");
      git(catalog, "commit", "-am", "Upstream update");
      const file = join(sources, kind === "untracked" ? "new-problem.txt" : "README.md");
      writeFileSync(file, "Unfinished author work\n");
      if (kind === "staged") git(sources, "add", "README.md");
      expectRejectedUpdate(fixture, "Problem sources have local changes");
      expect(readFileSync(file, "utf8")).toBe("Unfinished author work\n");
    });
  },
);

test("catalog refuses an unstaged pin selection or failed fetch without applying stale refs", () => {
  withCatalog((fixture) => {
    const { sources, git } = fixture;
    writeFileSync(join(sources, "README.md"), "Unstaged pin choice\n");
    git(sources, "commit", "-am", "Unstaged pin choice");
    expectRejectedUpdate(fixture, "differs from its staged pin");
  });
  withCatalog((fixture) => {
    const { sources, checkout, git } = fixture;
    git(sources, "remote", "set-url", "origin", join(checkout, "missing-remote"));
    expectRejectedUpdate(fixture, "does not appear to be a git repository");
  });
});

test("catalog respects the configured branch and protects ignored author files from checkout", () => {
  withCatalog(({ catalog, checkout, sources, git, update }) => {
    git(catalog, "checkout", "-b", "reviewed");
    writeFileSync(join(catalog, "README.md"), "Reviewed branch\n");
    git(catalog, "commit", "-am", "Reviewed branch");
    git(checkout, "config", "submodule.problems.branch", "reviewed");
    expect(update().status).toBe(0);
    expect(git(sources, "rev-parse", "HEAD")).toBe(git(catalog, "rev-parse", "HEAD"));
  });
  withCatalog((fixture) => {
    const { catalog, sources, git } = fixture;
    const ignored = join(sources, "generated.txt");
    writeFileSync(
      join(git(sources, "rev-parse", "--absolute-git-dir"), "info", "exclude"),
      "generated.txt\n",
    );
    writeFileSync(ignored, "Local ignored work\n");
    writeFileSync(join(catalog, "generated.txt"), "Upstream tracked file\n");
    git(catalog, "add", "generated.txt");
    git(catalog, "commit", "-m", "Add tracked file");
    expectRejectedUpdate(fixture, "would be overwritten by checkout");
    expect(readFileSync(ignored, "utf8")).toBe("Local ignored work\n");
  });
});

test("catalog validation uses the staged pin and build only produces local artifacts", () => {
  const validation = make("-n", "validate-problems");
  expect(validation.status).toBe(0);
  expect(validation.stdout).toContain("git submodule update --init problems");
  expect(validation.stdout).not.toContain("--remote");
  expect(validation.stdout).toContain("bun install --frozen-lockfile --ignore-scripts");
  expect(validation.stdout).toContain("bun run scripts/validate-problems.ts");
  const build = make("-n", "build");
  expect(build.status).toBe(0);
  expect(build.stdout).toContain("scripts/workspace/run-workspaces.ts build");
  expect(build.stdout).toContain("bun run build:host");
  expect(build.stdout).not.toContain("cloud-hosting/main.ts");
});

// Dry-run only: the CLI's injected subprocess suite verifies AWS and teardown semantics.
test("cloud product commands reach the existing scoped CLI without replacing local shutdown", () => {
  for (const [target, command] of [
    ["deploy", "up"],
    ["destroy", "down"],
  ]) {
    const result = make("-n", target ?? "", "CLOUD_ARGS=--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `bun run --no-env-file scripts/cloud-hosting/main.ts ${command} --help`,
    );
    expect(result.stdout).not.toContain("not implemented");
  }
  const local = make("-n", "down");
  expect(local.status).toBe(0);
  expect(local.stdout).toContain("scripts/local-host/local.ts down");
  expect(local.stdout).not.toContain("cloud-hosting");
});
