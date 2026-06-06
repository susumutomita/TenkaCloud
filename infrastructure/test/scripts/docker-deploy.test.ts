import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

/**
 * One-Docker deploy wrapper (host needs only Docker — no bun / node / aws-cli).
 *
 * The deliverable is `make deploy-docker`: a host with nothing but Docker installed can
 * still run the normal deploy. The wrapper is declarative (docker-compose.yml +
 * docker/Dockerfile) plus thin Makefile targets, so the test pins the *contract* those
 * files must satisfy rather than executing Docker (which is unavailable in CI):
 *
 *   - the toolchain image carries the exact versions the deploy path needs
 *   - the container can see the repo and authenticate to AWS
 *   - host node_modules (possibly built for another OS) never leak into the Linux container
 *   - the Makefile targets are pure `docker compose` so they run on a bun-less host
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");

interface ComposeFile {
  services: Record<
    string,
    {
      build?: { dockerfile?: string };
      volumes?: string[];
      environment?: string[];
    }
  >;
  volumes?: Record<string, unknown>;
}

describe("one-Docker deploy wrapper", () => {
  describe("docker-compose.yml", () => {
    const compose = parseYaml(read("docker-compose.yml")) as ComposeFile;
    const service = compose.services?.tenkacloud;

    it("should define a 'tenkacloud' service built from docker/Dockerfile", () => {
      expect(service).toBeDefined();
      expect(service.build?.dockerfile).toBe("docker/Dockerfile");
    });

    it("should bind-mount the repo at /workspace so local changes deploy as-is", () => {
      expect(service.volumes).toContain(".:/workspace");
    });

    it("should mount AWS credentials read-only so the deploy can authenticate", () => {
      const awsMount = service.volumes?.find((v) => v.endsWith(":/root/.aws:ro"));
      expect(awsMount).toBeDefined();
    });

    it("should shadow host node_modules with named volumes (no foreign-platform binaries leak in)", () => {
      for (const target of ["/workspace/node_modules", "/workspace/infrastructure/node_modules"]) {
        const shadowed = service.volumes?.some((v) => v.endsWith(`:${target}`));
        expect(shadowed, `expected a named volume mounted at ${target}`).toBe(true);
      }
    });

    it("should declare the named node_modules volumes at the top level", () => {
      const declared = Object.keys(compose.volumes ?? {});
      expect(declared.length).toBeGreaterThanOrEqual(2);
    });

    it("should pass host AWS auth and the target ENV through to the container", () => {
      for (const key of [
        "AWS_REGION",
        "AWS_DEFAULT_REGION",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "ENV",
      ]) {
        expect(service.environment).toContain(key);
      }
    });

    it("should not require AWS_PROFILE (a local `aws login` default profile is used automatically)", () => {
      expect(service.environment).not.toContain("AWS_PROFILE");
    });
  });

  describe("docker/Dockerfile", () => {
    const dockerfile = read("docker/Dockerfile");

    it("should base on Node 24 (the CDK CLI shebang and esbuild need a real Node runtime)", () => {
      expect(dockerfile).toMatch(/FROM node:24/);
    });

    it("should pin Bun to the package.json packageManager version", () => {
      const pkg = JSON.parse(read("package.json")) as { packageManager: string };
      const bunVersion = pkg.packageManager.replace("bun@", "");
      expect(dockerfile).toContain(bunVersion);
    });

    it("should install the AWS CLI (deploy scripts shell out to `aws`)", () => {
      expect(dockerfile).toMatch(/awscli/);
    });
  });

  describe("Makefile docker targets", () => {
    const makefile = read("Makefile");
    const recipeFor = (target: string): string =>
      makefile.split("\n").find((line) => line.startsWith(`${target}:`)) ?? "";

    it("should expose deploy-docker and destroy-docker targets", () => {
      expect(recipeFor("deploy-docker")).not.toBe("");
      expect(recipeFor("destroy-docker")).not.toBe("");
    });

    it("should drive deploy-docker through docker compose, never bun (host has no bun)", () => {
      const recipe = recipeFor("deploy-docker");
      expect(recipe).toContain("$(DOCKER_COMPOSE)");
      expect(recipe).not.toContain("bun");
    });

    it("should declare the docker targets as .PHONY", () => {
      const phony = makefile
        .split("\n")
        .filter((line) => line.includes(".PHONY") || line.trimStart().startsWith("deploy-docker"))
        .join(" ");
      expect(phony).toContain("deploy-docker");
      expect(phony).toContain("destroy-docker");
    });
  });
});
