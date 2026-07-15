import { posix } from "node:path";
import ts from "typescript";
import type { Finding, Rule, RuleContext } from "../types.ts";

const HANDLERS_MARKER = "/handlers/";
const CDK_PACKAGE = "aws-cdk-lib";

function isHandlerEntrypoint(path: string): boolean {
  if (!path.startsWith("infrastructure/lib/") || !path.endsWith(".ts")) return false;
  const markerIndex = path.indexOf(HANDLERS_MARKER);
  if (markerIndex < 0) return false;
  const handlerPath = path.slice(markerIndex + HANDLERS_MARKER.length);
  return handlerPath.endsWith("/index.ts") || !handlerPath.includes("/");
}

function isCdkSpecifier(specifier: string): boolean {
  return specifier === CDK_PACKAGE || specifier.startsWith(`${CDK_PACKAGE}/`);
}

function runtimeImports(content: string): readonly string[] {
  const source = ts.createSourceFile("runtime.ts", content, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && isRuntimeImportDeclaration(statement)) {
      imports.push(statement.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(statement) && isRuntimeExportDeclaration(statement)) {
      imports.push(statement.moduleSpecifier.text);
    }
  }
  collectRuntimeCallImports(source, imports);
  return imports;
}

function isRuntimeImportDeclaration(
  declaration: ts.ImportDeclaration,
): declaration is ts.ImportDeclaration & { moduleSpecifier: ts.StringLiteralLike } {
  if (!ts.isStringLiteralLike(declaration.moduleSpecifier)) return false;
  const clause = declaration.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  const bindings = clause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

function isRuntimeExportDeclaration(
  declaration: ts.ExportDeclaration,
): declaration is ts.ExportDeclaration & { moduleSpecifier: ts.StringLiteralLike } {
  if (!declaration.moduleSpecifier || !ts.isStringLiteralLike(declaration.moduleSpecifier)) {
    return false;
  }
  if (declaration.isTypeOnly) return false;
  const clause = declaration.exportClause;
  if (!clause || ts.isNamespaceExport(clause)) return true;
  return clause.elements.some((element) => !element.isTypeOnly);
}

function collectRuntimeCallImports(node: ts.Node, imports: string[]): void {
  if (ts.isCallExpression(node) && node.arguments.length > 0) {
    const specifier = node.arguments[0];
    const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
    if ((isDynamicImport || isRequire) && specifier && ts.isStringLiteralLike(specifier)) {
      imports.push(specifier.text);
    }
  }
  ts.forEachChild(node, (child) => collectRuntimeCallImports(child, imports));
}

function resolveRelativeImport(
  fromPath: string,
  specifier: string,
  trackedFiles: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const unresolved = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  const withoutJsExtension = unresolved.replace(/\.(?:c|m)?js$/, "");
  const candidates = [
    unresolved,
    `${withoutJsExtension}.ts`,
    `${withoutJsExtension}.tsx`,
    `${unresolved}/index.ts`,
    `${unresolved}/index.tsx`,
  ];
  return candidates.find((candidate) => trackedFiles.has(candidate));
}

function findCdkImportChain(
  ctx: RuleContext,
  trackedFiles: ReadonlySet<string>,
  path: string,
  chain: readonly string[],
  visited: Set<string>,
): readonly string[] | undefined {
  if (visited.has(path)) return undefined;
  visited.add(path);

  let content: string;
  try {
    content = ctx.readFile(path);
  } catch {
    return undefined;
  }

  for (const specifier of runtimeImports(content)) {
    if (isCdkSpecifier(specifier)) return [...chain, specifier];
    const dependency = resolveRelativeImport(path, specifier, trackedFiles);
    if (!dependency) continue;
    const leak = findCdkImportChain(ctx, trackedFiles, dependency, [...chain, dependency], visited);
    if (leak) return leak;
  }
  return undefined;
}

export const handlerNoTransitiveCdkImport: Rule = {
  id: "handler-no-transitive-cdk-import",
  severity: "error",
  check(ctx): readonly Finding[] {
    const trackedFiles = new Set(ctx.allFiles ?? ctx.files);
    const findings: Finding[] = [];
    for (const entrypoint of trackedFiles) {
      if (!isHandlerEntrypoint(entrypoint)) continue;
      const chain = findCdkImportChain(ctx, trackedFiles, entrypoint, [entrypoint], new Set());
      if (!chain) continue;
      findings.push({
        ruleId: "handler-no-transitive-cdk-import",
        severity: "error",
        filePath: entrypoint,
        match: CDK_PACKAGE,
        message: `Lambda runtime import graph reaches aws-cdk-lib: ${chain.join(" -> ")}`,
        recommendation:
          "Move runtime helpers into a CDK-free module and import that module from repositories " +
          "or handlers. Keep constructs and runtime code in separate dependency branches.",
      });
    }
    return findings;
  },
};
