import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Same containment/symlink rule as the published content-addressed artifact producer. */
export function repositoryArtifactFile(repositoryRoot: string, artifact: string): string {
  const selectedRoot = resolve(repositoryRoot);
  if (lstatSync(selectedRoot).isSymbolicLink() || !lstatSync(selectedRoot).isDirectory())
    throw new Error("Execution artifacts require an unlinked repository directory.");
  const root = realpathSync(selectedRoot);
  const file = resolve(root, artifact);
  const withinRoot = relative(root, file);
  if (
    !withinRoot ||
    withinRoot === ".." ||
    withinRoot.startsWith(`..${sep}`) ||
    isAbsolute(withinRoot)
  )
    throw new Error("Execution artifacts must be inside the repository.");
  let current = root;
  const components = withinRoot.split(sep);
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    const entry = lstatSync(current);
    if (entry.isSymbolicLink())
      throw new Error("Execution artifact paths must not contain symbolic links.");
    if (index === components.length - 1 ? !entry.isFile() : !entry.isDirectory())
      throw new Error("Execution artifacts must be regular files.");
  }
  return file;
}
