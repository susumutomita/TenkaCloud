import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";
import { compareCodePoints } from "../lib/code-point-order";

const forbidden = ["infrastructure/", "scripts/local-play/"];
const options: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ESNext,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
};
function isModuleCall(node: ts.CallExpression): boolean {
  return (
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === "require")
  );
}
function moduleLiteral(node: ts.Node): ts.Node | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
    return node.argument.literal;
  if (ts.isCallExpression(node) && isModuleCall(node)) return node.arguments[0];
  return undefined;
}
function moduleNames(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>();
  function visit(node: ts.Node): void {
    const literal = moduleLiteral(node);
    if (literal && ts.isStringLiteral(literal)) names.add(literal.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...names];
}
function dependencies(file: string): string[] {
  const files: string[] = [];
  for (const specifier of moduleNames(file)) {
    const imported = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule;
    if (imported) files.push(imported.resolvedFileName);
    else if (specifier.startsWith(".") || specifier.startsWith("@tenkacloud/"))
      throw new Error(`Unresolved host dependency: ${file} -> ${specifier}`);
  }
  return files;
}

/** Include type-only imports: moving an adapter must not leave its DTO coupled to the old backend. */
export function hostImportClosure(
  repositoryRoot: string,
  entries = ["scripts/local-host/main.ts"],
): readonly string[] {
  const root = realpathSync(repositoryRoot);
  const seen = new Set<string>();
  const pending = entries.map((entry) => resolve(root, entry));
  while (pending.length) {
    const next = pending.pop();
    if (!next) continue;
    const file = realpathSync(next);
    const name = relative(root, file).replaceAll("\\", "/");
    if (name.startsWith("../") || isAbsolute(name) || name.startsWith("node_modules/")) continue;
    if (forbidden.some((prefix) => name.startsWith(prefix)))
      throw new Error(`Host dependency reaches ${name}`);
    if (seen.has(name)) continue;
    seen.add(name);
    if (/\.[cm]?tsx?$/.test(file)) pending.push(...dependencies(file));
  }
  return [...seen].sort(compareCodePoints);
}

if (import.meta.main) {
  const root = resolve(dirname(import.meta.path), "../..");
  console.log(
    `Host import closure: ${hostImportClosure(root).length} source files; no infrastructure or local-play imports (including types).`,
  );
}
