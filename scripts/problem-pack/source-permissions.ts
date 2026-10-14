import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const marker = ".tenkacloud-source-modes.json";
const Modes = z
  .object({
    schemaVersion: z.literal(1),
    executables: z.array(
      z
        .string()
        .refine(
          (path) =>
            path.length > 0 &&
            !path.startsWith("/") &&
            !path.includes("\\") &&
            !path.split("/").includes(".."),
        ),
    ),
  })
  .strict();
function sourceFiles(root: string, relative = ""): string[] {
  const directory = lstatSync(root);
  if (directory.isSymbolicLink() || !directory.isDirectory())
    throw new Error("Catalog root must be an unlinked directory");
  const files: string[] = [];
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const file = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error("Catalog contains a symbolic link");
    if (entry.isDirectory()) files.push(...sourceFiles(root, file));
    else if (entry.isFile()) files.push(file);
    else throw new Error("Unsupported catalog file type");
  }
  return files;
}
/** A platform-owned, digested manifest binds executable intent, even if a cloud restore resets file modes. */
export function sealSourcePermissions(root: string): void {
  if (existsSync(join(root, marker)))
    throw new Error("Catalog uses reserved source permission manifest");
  const executables = sourceFiles(root)
    .filter((file) => (lstatSync(join(root, file)).mode & 0o100) !== 0)
    .sort((left, right) => {
      if (left === right) return 0;
      return left < right ? -1 : 1;
    });
  writeFileSync(join(root, marker), JSON.stringify({ schemaVersion: 1, executables }));
  restoreSourcePermissions(root);
}
export function restoreSourcePermissions(root: string): void {
  const files = sourceFiles(root);
  const manifest = existsSync(join(root, marker))
    ? Modes.parse(JSON.parse(readFileSync(join(root, marker), "utf8")))
    : undefined;
  const executables = new Set(
    manifest?.executables ??
      files.filter((file) => (lstatSync(join(root, file)).mode & 0o100) !== 0),
  );
  if ([...executables].some((file) => !files.includes(file)))
    throw new Error("Catalog executable path is missing");
  const directories = new Set([root]);
  for (const file of files) {
    const segments = file.split("/");
    for (let index = 1; index < segments.length; index++)
      directories.add(join(root, ...segments.slice(0, index)));
    const mode = executables.has(file) ? 0o755 : 0o644;
    if ((lstatSync(join(root, file)).mode & 0o7777) !== mode) chmodSync(join(root, file), mode);
  }
  for (const directory of directories)
    if ((lstatSync(directory).mode & 0o7777) !== 0o755) chmodSync(directory, 0o755);
}
