import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

async function assertInsideRoot(resolvedRoot, candidate) {
  const resolvedCandidate = await realpath(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Problem content escapes the configured directory: ${candidate}`);
  }
}

async function validateTree(root, resolvedRoot, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(current, entry.name);
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed: ${candidate}`);
    }
    await assertInsideRoot(resolvedRoot, candidate);
    if (stat.isDirectory()) {
      await validateTree(root, resolvedRoot, candidate);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Only regular files and directories are allowed: ${candidate}`);
    }
  }
}

export async function validateProblemsDirectory(directory) {
  const root = path.resolve(directory);
  const rootStat = await lstat(root).catch(() => undefined);
  // The symlink test has to come first. `lstat` on a link-to-directory reports
  // `isDirectory() === false`, so with the order reversed the directory check
  // fired instead and a symlinked root was refused as "does not exist" — the
  // right outcome for the wrong reason, and an unreachable branch below it.
  if (rootStat?.isSymbolicLink()) {
    throw new Error(`Problems directory must not be a symbolic link: ${root}`);
  }
  if (!rootStat?.isDirectory()) {
    throw new Error(`Problems directory does not exist or is not a directory: ${root}`);
  }

  const resolvedRoot = await realpath(root);
  await validateTree(root, resolvedRoot);

  const entries = await readdir(root, { withFileTypes: true });
  const problems = [];
  const ids = new Set();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory()) continue;

    const problemDirectory = path.join(root, entry.name);
    await assertInsideRoot(resolvedRoot, problemDirectory);
    const metadataPath = path.join(problemDirectory, "metadata.json");
    const metadataStat = await lstat(metadataPath).catch(() => undefined);
    if (!metadataStat?.isFile() || metadataStat.isSymbolicLink()) {
      throw new Error(`Problem '${entry.name}' must contain a regular metadata.json file.`);
    }

    let metadata;
    try {
      metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    } catch (error) {
      throw new Error(`Problem '${entry.name}' has invalid metadata.json: ${error.message}`);
    }
    const problemId =
      typeof metadata.id === "string" && metadata.id.trim() ? metadata.id.trim() : entry.name;
    if (problemId !== entry.name) {
      throw new Error(`Problem directory '${entry.name}' must match metadata id '${problemId}'.`);
    }
    if (ids.has(problemId)) throw new Error(`Duplicate problem id: ${problemId}`);
    ids.add(problemId);
    problems.push({ id: problemId, directory: problemDirectory });
  }

  if (problems.length === 0) {
    throw new Error(`No problems with metadata.json were found in ${root}.`);
  }
  return { root, problems };
}
