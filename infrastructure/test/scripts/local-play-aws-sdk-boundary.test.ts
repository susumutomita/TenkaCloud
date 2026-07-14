import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

function runtimeSpecifiers(path: string): readonly string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const clause = statement.importClause;
    if (clause?.isTypeOnly) continue;
    if (
      clause?.namedBindings &&
      ts.isNamedImports(clause.namedBindings) &&
      !clause.name &&
      clause.namedBindings.elements.every((element) => element.isTypeOnly)
    ) {
      continue;
    }
    specifiers.push(statement.moduleSpecifier.text);
  }
  return specifiers;
}

function resolveLocalModule(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(importer), specifier.replace(/\.js$/, ""));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Unable to resolve local runtime import ${specifier} from ${importer}`);
}

function transitiveAwsSdkImports(entrypoint: string): readonly string[] {
  const pending = [entrypoint];
  const visited = new Set<string>();
  const awsImports = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || visited.has(path)) continue;
    visited.add(path);
    for (const specifier of runtimeSpecifiers(path)) {
      if (specifier.startsWith("@aws-sdk/")) awsImports.add(specifier);
      const local = resolveLocalModule(path, specifier);
      if (local) pending.push(local);
    }
  }
  return [...awsImports].sort();
}

describe("local-play AWS SDK runtime boundary (#2633)", () => {
  it("should keep the local CLI runtime graph free of every AWS SDK package", () => {
    expect(transitiveAwsSdkImports(resolve(REPO_ROOT, "scripts", "tenkacloud.ts"))).toEqual([]);
  });
});
