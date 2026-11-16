import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { join } from "node:path";

export class TerraformInputError extends Error {}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TerraformInputError("Expected object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new TerraformInputError("Unsupported configuration key");
}
function literals(value: unknown): void {
  if (typeof value === "string" && /\$\{|%\{/.test(value))
    throw new TerraformInputError("Expressions are not supported");
  if (value && typeof value === "object") for (const child of Object.values(value)) literals(child);
}
function validateProviders(
  root: Record<string, unknown>,
  terraform: Record<string, unknown>,
  kintone: boolean,
): void {
  const providers = object(terraform.required_providers ?? {});
  keys(providers, kintone ? ["kintone"] : []);
  if (kintone) {
    const provider = object(providers.kintone);
    keys(provider, ["source", "version"]);
    if (
      provider.source !== "susumutomita/kintone" ||
      typeof provider.version !== "string" ||
      !/^= \d+\.\d+\.\d+$/.test(provider.version)
    )
      throw new TerraformInputError("Pin reviewed kintone provider");
  }
  const config = object(root.provider ?? {});
  keys(config, kintone ? ["kintone"] : []);
  if (config.kintone) keys(object(config.kintone), []);
}
function validateRight(entry: unknown): void {
  const right = object(entry);
  keys(right, [
    "entity_type",
    "entity_code",
    "include_subs",
    "app_editable",
    "record_viewable",
    "record_addable",
    "record_editable",
    "record_deletable",
    "record_importable",
    "record_exportable",
  ]);
  if (!["USER", "GROUP", "ORGANIZATION", "CREATOR"].includes(String(right.entity_type)))
    throw new TerraformInputError("Invalid principal");
  for (const [key, val] of Object.entries(right))
    if (typeof val !== (key.startsWith("entity_") ? "string" : "boolean"))
      throw new TerraformInputError("Invalid ACL value");
}
function validateApp(attrs: Record<string, unknown>): void {
  keys(attrs, ["name", "description", "rights"]);
  if (typeof attrs.name !== "string" || !attrs.name.trim())
    throw new TerraformInputError("App name required");
  if (attrs.description !== undefined && typeof attrs.description !== "string")
    throw new TerraformInputError("Invalid description");
  if (!Array.isArray(attrs.rights) || !attrs.rights.length)
    throw new TerraformInputError("ACL required");
  for (const entry of attrs.rights) validateRight(entry);
}
export function validateConfig(value: unknown): boolean {
  const root = object(value);
  keys(root, ["terraform", "provider", "resource"]);
  literals(root);
  const terraform = object(root.terraform);
  keys(terraform, ["required_version", "required_providers"]);
  if (
    typeof terraform.required_version !== "string" ||
    !/^= \d+\.\d+\.\d+$/.test(terraform.required_version)
  )
    throw new TerraformInputError("Pin Terraform version exactly");
  const resources = object(root.resource);
  keys(resources, ["kintone_app", "terraform_data"]);
  if (!Object.keys(resources).length) throw new TerraformInputError("Resources required");
  const kintone = "kintone_app" in resources;
  validateProviders(root, terraform, kintone);
  for (const [type, instances] of Object.entries(resources)) {
    for (const [name, settings] of Object.entries(object(instances))) {
      if (!/^[a-zA-Z]\w*$/.test(name)) throw new TerraformInputError("Invalid resource name");
      const attrs = object(settings);
      if (type === "terraform_data") keys(attrs, ["input"]);
      else {
        validateApp(attrs);
      }
    }
  }
  return kintone;
}
// Binary lexical ordering keeps review digests independent of the machine locale.
function comparePaths(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
export function readBundle(directory: string): {
  files: Map<string, Buffer>;
  digest: string;
  kintone: boolean;
} {
  const files = new Map<string, Buffer>();
  let bytes = 0;
  function addFile(path: string, relative: string, stat: Stats): void {
    if (
      !stat.isFile() ||
      (relative !== "main.tf.json" &&
        relative !== ".terraform.lock.hcl" &&
        !relative.startsWith("mirror/"))
    )
      throw new TerraformInputError("Unexpected bundle file");
    bytes += stat.size;
    if (bytes > 256 * 1024 * 1024 || files.size >= 1000)
      throw new TerraformInputError("Bundle too large");
    files.set(relative, readFileSync(path));
  }
  function walk(path: string, relative: string): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new TerraformInputError("Symlinks forbidden");
    if (!stat.isDirectory()) {
      addFile(path, relative, stat);
      return;
    }
    if (relative && relative !== "mirror" && !relative.startsWith("mirror/"))
      throw new TerraformInputError("Unexpected bundle directory");
    for (const name of readdirSync(path).sort(comparePaths))
      walk(join(path, name), relative ? `${relative}/${name}` : name);
  }
  walk(directory, "");
  if (!files.has("main.tf.json") || !files.has(".terraform.lock.hcl"))
    throw new TerraformInputError("Configuration and reviewed lockfile required");
  const kintone = validateConfig(JSON.parse(files.get("main.tf.json")?.toString() ?? ""));
  if (kintone && ![...files.keys()].some((key) => key.startsWith("mirror/")))
    throw new TerraformInputError("Reviewed provider mirror required");
  const digest = sha256(JSON.stringify([...files].map(([name, data]) => [name, sha256(data)])));
  return { files, digest, kintone };
}
