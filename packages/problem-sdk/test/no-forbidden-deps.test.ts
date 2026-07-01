/**
 * [Problem SDK / Issue #2106] The SDK must stay a dependency-light leaf: no CDK,
 * AWS SDK, Lambda runtime, DB client, Hono, or React/browser code — in either the
 * declared dependencies or the source import graph.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const srcDir = path.join(packageRoot, "src");

/** Forbidden dependency-name prefixes / packages a leaf authoring SDK must never pull in. */
const FORBIDDEN_PACKAGES = [
  "aws-cdk-lib",
  "aws-cdk",
  "@aws-cdk/",
  "@aws-sdk/",
  "aws-lambda",
  "@types/aws-lambda",
  "hono",
  "react",
  "react-dom",
  "@cdklabs/sbt-aws",
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function collectImportSpecifiers(file: string): string[] {
  const source = fs.readFileSync(file, "utf-8");
  const specifiers: string[] = [];
  const importRe = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g;
  const dynamicRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  // Bare side-effect import, e.g. `import "@aws-sdk/client-s3";` — no `from`.
  const sideEffectRe = /^\s*import\s+['"]([^'"]+)['"]/gm;
  for (const re of [importRe, dynamicRe, requireRe, sideEffectRe]) {
    let match: RegExpExecArray | null = re.exec(source);
    while (match !== null) {
      specifiers.push(match[1]);
      match = re.exec(source);
    }
  }
  return specifiers;
}

/** True when a bare (non-relative, non-node:) specifier matches a forbidden package. */
function isForbiddenSpecifier(specifier: string): boolean {
  if (specifier.startsWith(".") || specifier.startsWith("node:")) return false;
  return FORBIDDEN_PACKAGES.some(
    (forbidden) => specifier === forbidden || specifier.startsWith(forbidden),
  );
}

describe("@tenkacloud/problem-sdk dependency isolation", () => {
  it("should export no AWS SDK or CDK dependency in package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const declared = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ];
    for (const name of declared) {
      for (const forbidden of FORBIDDEN_PACKAGES) {
        expect(name.startsWith(forbidden) || name === forbidden).toBe(false);
      }
    }
  });

  it("should import no AWS SDK or CDK dependency across the source import graph", () => {
    const offenders = listSourceFiles(srcDir).flatMap((file) =>
      collectImportSpecifiers(file)
        .filter(isForbiddenSpecifier)
        .map((specifier) => `${path.relative(packageRoot, file)} -> ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });
});
