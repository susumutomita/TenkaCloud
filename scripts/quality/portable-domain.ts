import { resolve } from "node:path";
import ts from "typescript";
import { hostRuntimeImportClosure } from "./host-imports.js";

const entries = [
  "scripts/local-host/hosting-domain.ts",
  "scripts/lib/hosting-api.ts",
  "scripts/local-host/organizer-passwords.ts",
  "scripts/local-host/organizer-principal.ts",
];
function moduleReference(node: ts.Node): ts.Node | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
    return node.argument.literal;
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  )
    return node.arguments[0];
  return undefined;
}

function computedBunAccess(node: ts.Node): boolean {
  return (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteral(node.argumentExpression) &&
    node.argumentExpression.text === "Bun"
  );
}

function concreteProvider(reference: ts.Node): boolean {
  if (!ts.isStringLiteral(reference))
    throw new Error("Portable domain has computed module reference.");
  return /^(?:bun:|@aws-sdk\/|@smithy\/)/u.test(reference.text);
}
function principalType(type: ts.Type | undefined, cache: WeakMap<ts.Type, boolean>): boolean {
  if (!type) return false;
  const cached = cache.get(type);
  if (cached !== undefined) return cached;
  const branded = type
    .getProperties()
    .some((property) => property.name.startsWith("__@authenticatedOrganizer"));
  cache.set(type, branded);
  return branded;
}

/** A unique-symbol property must be written with a computed name or copied by spread. */
function canCarryPrincipalBrand(node: ts.ObjectLiteralExpression): boolean {
  return node.properties.some((property) => {
    if (ts.isSpreadAssignment(property)) return true;
    const name = property.name;
    return (
      ts.isComputedPropertyName(name) ||
      ((ts.isIdentifier(name) ||
        ts.isStringLiteral(name) ||
        ts.isNoSubstitutionTemplateLiteral(name)) &&
        name.text.startsWith("__@authenticatedOrganizer"))
    );
  });
}

function principalConversion(
  node: ts.Node,
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  cache: WeakMap<ts.Type, boolean>,
): boolean {
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
    return (
      node.type.getText(source).endsWith("OrganizerPrincipal") ||
      principalType(checker.getTypeFromTypeNode(node.type), cache)
    );
  if (
    ts.isObjectLiteralExpression(node) &&
    canCarryPrincipalBrand(node) &&
    principalType(checker.getTypeAtLocation(node), cache)
  )
    return true;
  return (
    ts.isExpression(node) &&
    principalType(checker.getContextualType(node), cache) &&
    (checker.getTypeAtLocation(node).flags & ts.TypeFlags.Any) !== 0
  );
}

/** No Bun globals/drivers or AWS SDK implementations in the domain's runtime graph. */
export function assertPortableDomain(root: string, roots = entries): readonly string[] {
  const files = hostRuntimeImportClosure(root, roots);
  const program = ts.createProgram(
    files.map((file) => resolve(root, file)),
    {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      types: [],
      skipLibCheck: true,
    },
  );
  const checker = program.getTypeChecker();
  const principalTypes = new WeakMap<ts.Type, boolean>();
  for (const file of files) {
    const found = program.getSourceFile(resolve(root, file));
    if (!found) throw new Error(`Portable domain source is unavailable: ${file}`);
    const source = found;
    function visit(node: ts.Node): void {
      const reference = moduleReference(node);
      if (reference && concreteProvider(reference))
        throw new Error(
          `Portable domain imports concrete provider: ${file} -> ${reference.getText(source)}`,
        );
      if (ts.isIdentifier(node) && node.text === "Bun")
        throw new Error(`Portable domain uses Bun global: ${file}`);
      if (computedBunAccess(node)) throw new Error(`Portable domain uses Bun global: ${file}`);
      if (
        file !== "scripts/local-host/store.ts" &&
        principalConversion(node, source, checker, principalTypes)
      )
        throw new Error(`Portable domain manufactures organizer principal: ${file}`);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return files;
}

if (import.meta.main) {
  const files = assertPortableDomain(process.cwd());
  if (!files.includes("scripts/local-host/participant-aws-contract.ts"))
    throw new Error("Portable domain runtime graph is missing participant AWS contracts.");
  console.log(`Portable domain: ${files.length} runtime source files checked.`);
}
