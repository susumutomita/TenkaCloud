import { cpSync, lstatSync, realpathSync } from "node:fs";
import { basename } from "node:path";

/** Copy author content only; never follow links or run Git/package scripts. */
export function copyLocalCatalog(source: string, destination: string): void {
  const root = lstatSync(source);
  if (root.isSymbolicLink() || !root.isDirectory())
    throw new Error("Local catalog path must be an unlinked directory");
  const canonical = realpathSync(source);
  cpSync(canonical, destination, {
    recursive: true,
    filter: (path) => {
      if (path !== canonical && excludedLocalFile(basename(path))) return false;
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) throw new Error("Local catalog contains a symbolic link");
      if (!entry.isDirectory() && !entry.isFile())
        throw new Error("Local catalog contains an unsupported file");
      return true;
    },
  });
}

/** Exclude local configuration, credentials and build/dependency trees. */
function excludedLocalFile(name: string): boolean {
  return (
    name.startsWith(".") ||
    ["node_modules", "dist", "coverage"].includes(name) ||
    /^(?:credentials?|secrets?)(?:[._-]|$)/iu.test(name) ||
    /\.(?:pem|key|p12|pfx|kdbx)$/iu.test(name) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/u.test(name)
  );
}
