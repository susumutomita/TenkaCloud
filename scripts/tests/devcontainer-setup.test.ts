import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "../..");
const config = JSON.parse(
  readFileSync(join(repository, ".devcontainer/devcontainer.json"), "utf8"),
);
const installer = `#!/bin/sh
printf 'download %s\\n' "$*" >> "$TRACE"
if [ "\${FAIL_DOWNLOAD:-}" = 1 ]; then exit 22; fi
cat <<'INSTALLER'
set -eu
if [ "\${MISSING_BINARY:-}" = 1 ]; then exit 0; fi
printf 'install %s\\n' "$*" >> "$TRACE"
version="\${1#bun-v}"
if [ "\${BAD_INSTALL:-}" = 1 ]; then version=0.0.0; fi
mkdir -p "$BUN_INSTALL/bin"
printf '#!/bin/sh\\nif [ "$1" = --version ]; then echo %s; else printf "bun %%s\\\\n" "$*" >> "$TRACE"; fi\\n' "$version" > "$BUN_INSTALL/bin/bun"
chmod +x "$BUN_INSTALL/bin/bun"
INSTALLER
`;

function fixture(operation: (input: ReturnType<typeof createFixture>) => void): void {
  const input = createFixture();
  try {
    operation(input);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "tenka-devcontainer-"));
  mkdirSync(join(root, ".devcontainer"));
  mkdirSync(join(root, "commands"));
  for (const file of ["mise.toml", "Makefile", ".devcontainer/post-create.sh"])
    copyFileSync(join(repository, file), join(root, file));
  writeFileSync(join(root, "commands/curl"), installer, { mode: 0o755 });
  const installation = join(root, "bun-install");
  const trace = join(root, "trace");
  const run = (extra: Record<string, string> = {}) =>
    spawnSync("/bin/bash", [join(root, ".devcontainer/post-create.sh")], {
      // No global Bun or real download: only the fixture's curl and installed binary.
      cwd: tmpdir(),
      env: {
        ...process.env,
        PATH: `${join(root, "commands")}:/usr/bin:/bin`,
        BUN_INSTALL: installation,
        TRACE: trace,
        ...extra,
      },
      encoding: "utf8",
      timeout: 10_000,
    });
  return { root, installation, run, trace: () => readFileSync(trace, "utf8") };
}

test("a missing Bun is installed at the mise pin before the real safe Make install target", () => {
  fixture((input) => {
    expect(config.postCreateCommand).toEqual(["bash", ".devcontainer/post-create.sh"]);
    expect(config.remoteEnv.BUN_INSTALL).toBe("/home/codespace/.bun");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Dev Containers expands this literal.
    expect(config.remoteEnv.PATH).toBe("/home/codespace/.bun/bin:${containerEnv:PATH}");
    const result = input.run();
    expect(result.status).toBe(0);
    const trace = input.trace();
    expect(trace).toContain("https://bun.com/install");
    expect(trace).toContain("install bun-v1.3.11\n");
    expect(trace).toContain("bun install --ignore-scripts\n");
    expect(trace).toContain("bun x husky\n");
    expect(trace.indexOf("install bun-v1.3.11")).toBeLessThan(
      trace.indexOf("bun install --ignore-scripts"),
    );
    expect(trace).not.toContain("submodule");
  });
});

test("an exact private Bun is reused but a different version is repaired", () => {
  fixture((input) => {
    expect(input.run().status).toBe(0);
    expect(input.run().status).toBe(0);
    expect(input.trace().match(/download /gu)).toHaveLength(1);
    writeFileSync(join(input.installation, "bin/bun"), "#!/bin/sh\necho 0.0.0\n");
    expect(input.run().status).toBe(0);
    expect(input.trace().match(/download /gu)).toHaveLength(2);
  });
});

test("a failed official download stops before dependency installation", () => {
  fixture((input) => {
    expect(input.run({ FAIL_DOWNLOAD: "1" }).status).not.toBe(0);
    expect(input.trace()).not.toContain("bun install");
  });
});

test("an installer that fails to provide the pin cannot proceed to Make", () => {
  fixture((input) => {
    const result = input.run({ BAD_INSTALL: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did not provide the pinned version");
    expect(input.trace()).not.toContain("bun install");
  });
});

test("installer success without a Bun binary cannot proceed to Make", () => {
  fixture((input) => {
    const result = input.run({ MISSING_BINARY: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did not provide the pinned version");
    expect(input.trace()).not.toContain("bun install");
  });
});
