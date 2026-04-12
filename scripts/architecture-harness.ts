#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  analyzeArchitecture,
  formatArchitectureReportAsMarkdown,
  getArchitectureHarnessAuthoritativePaths,
  hasArchitectureFindingsAtOrAboveSeverity,
  shouldAnalyzeArchitectureFile,
  type ArchitectureFile,
  type ArchitectureSeverity,
} from '../packages/shared/src/quality';

interface CliOptions {
  root: string;
  staged: boolean;
  failOn?: ArchitectureSeverity;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    root: process.cwd(),
    staged: false,
    failOn: undefined,
  };

  for (const arg of argv) {
    if (arg === '--staged') {
      options.staged = true;
      continue;
    }
    if (arg.startsWith('--root=')) {
      options.root = path.resolve(arg.slice('--root='.length));
      continue;
    }
    if (arg.startsWith('--fail-on=')) {
      const severity = arg.slice('--fail-on='.length) as ArchitectureSeverity;
      if (severity === 'error' || severity === 'warning') {
        options.failOn = severity;
      }
    }
  }

  return options;
}

async function collectRepositoryFiles(root: string): Promise<ArchitectureFile[]> {
  const files: ArchitectureFile[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(root, absolutePath);

      if (entry.isDirectory()) {
        if (
          ['node_modules', '.git', '.next', 'coverage', 'dist', 'build', 'out']
            .includes(entry.name)
        ) {
          continue;
        }
        await walk(absolutePath);
        continue;
      }

      if (!shouldAnalyzeArchitectureFile(relativePath)) {
        continue;
      }

      files.push({
        path: relativePath,
        content: await readFile(absolutePath, 'utf8'),
      });
    }
  }

  await walk(root);
  return files;
}

async function collectStagedFiles(root: string): Promise<ArchitectureFile[]> {
  const output = execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
    {
      cwd: root,
      encoding: 'utf8',
    }
  );

  const paths = new Set(
    output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((filePath) => shouldAnalyzeArchitectureFile(filePath))
  );

  for (const filePath of getArchitectureHarnessAuthoritativePaths()) {
    paths.add(filePath);
  }

  const files = await Promise.all(
    [...paths].map(async (filePath) => ({
      path: filePath,
      content: await readFile(path.join(root, filePath), 'utf8'),
    }))
  );

  return files;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = options.staged
    ? await collectStagedFiles(options.root)
    : await collectRepositoryFiles(options.root);

  const report = analyzeArchitecture(files);
  console.log(formatArchitectureReportAsMarkdown(report));

  if (
    options.failOn &&
    hasArchitectureFindingsAtOrAboveSeverity(report, options.failOn)
  ) {
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  console.error('[architecture-harness] failed:', error);
  process.exitCode = 1;
});
