#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  analyzeRepository,
  formatImprovementReportAsMarkdown,
  hasFindingsAtOrAboveSeverity,
  shouldAnalyzeFile,
  type DebtSeverity,
  type RepositoryFile,
} from '../packages/shared/src/quality';

interface CliOptions {
  root: string;
  top: number;
  write: boolean;
  failOn?: DebtSeverity;
  staged: boolean;
}

const OUTPUT_DIR = 'docs/tech-debt';
const OUTPUT_JSON = `${OUTPUT_DIR}/backlog.json`;
const OUTPUT_MARKDOWN = `${OUTPUT_DIR}/backlog.md`;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    root: process.cwd(),
    top: 10,
    write: false,
    failOn: undefined,
    staged: false,
  };

  for (const arg of argv) {
    if (arg === '--write') {
      options.write = true;
      continue;
    }
    if (arg === '--staged') {
      options.staged = true;
      continue;
    }
    if (arg.startsWith('--root=')) {
      options.root = path.resolve(arg.slice('--root='.length));
      continue;
    }
    if (arg.startsWith('--top=')) {
      const parsed = Number.parseInt(arg.slice('--top='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.top = parsed;
      }
      continue;
    }
    if (arg.startsWith('--fail-on=')) {
      const value = arg.slice('--fail-on='.length) as DebtSeverity;
      if (value === 'critical' || value === 'high' || value === 'medium') {
        options.failOn = value;
      }
    }
  }

  return options;
}

async function collectRepositoryFiles(root: string): Promise<RepositoryFile[]> {
  const files: RepositoryFile[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(root, absolutePath);

      if (entry.isDirectory()) {
        if (!shouldDescend(relativePath)) {
          continue;
        }
        await walk(absolutePath);
        continue;
      }

      if (!shouldAnalyzeFile(relativePath)) {
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

async function collectStagedFiles(root: string): Promise<RepositoryFile[]> {
  // Pure rename (R100、内容変更なし) は新規負債ではないので除外する。
  // 同 PR で巨大な既存ファイルを単純移動しただけで loop が失敗するのを防ぐ。
  const renameThreshold = '90';
  const output = execFileSync(
    'git',
    [
      'diff',
      '--cached',
      '--name-status',
      `--find-renames=${renameThreshold}%`,
      '--diff-filter=ACMR',
    ],
    {
      cwd: root,
      encoding: 'utf8',
    }
  );

  const candidates: string[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split('\t');
    const status = parts[0];
    if (!status) continue;
    if (status.startsWith('R')) {
      // R100 は内容無変更、それより低い類似度は内容変更ありなので新規パス側を analyze
      const similarity = Number.parseInt(status.slice(1), 10);
      if (similarity >= 100) continue;
      const newPath = parts[2];
      if (newPath) candidates.push(newPath);
      continue;
    }
    const filePath = parts[1];
    if (filePath) candidates.push(filePath);
  }

  const files = await Promise.all(
    candidates
      .filter((filePath) => shouldAnalyzeFile(filePath))
      .map(async (filePath) => ({
        path: filePath,
        content: await readFile(path.join(root, filePath), 'utf8'),
      }))
  );

  return files;
}

function shouldDescend(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join('/');
  return ![
    'node_modules',
    '.git',
    '.next',
    'coverage',
    'dist',
    'build',
    'out',
  ].some(
    (segment) => normalized === segment || normalized.includes(`/${segment}/`)
  );
}

function printSummary(markdown: string, top: number): string {
  const lines = markdown.split('\n');
  const findingsHeaderIndex = lines.findIndex((line) => line === '## Findings');
  if (findingsHeaderIndex === -1) {
    return markdown;
  }

  const preview = lines.slice(0, findingsHeaderIndex).join('\n');
  const findingSections: string[] = [];
  const findingLines = lines.slice(findingsHeaderIndex + 2);
  let current: string[] = [];

  for (const line of findingLines) {
    if (line.startsWith('### ')) {
      if (current.length > 0) {
        findingSections.push(current.join('\n'));
      }
      current = [line];
      continue;
    }

    if (current.length > 0) {
      current.push(line);
    }
  }

  if (current.length > 0) {
    findingSections.push(current.join('\n'));
  }

  return `${preview}\n\n## Top Findings\n\n${findingSections
    .slice(0, top)
    .join('\n\n')}`.trimEnd();
}

async function writeBacklogArtifacts(
  root: string,
  json: string,
  markdown: string
): Promise<void> {
  const outputDir = path.join(root, OUTPUT_DIR);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(root, OUTPUT_JSON), `${json}\n`, 'utf8');
  await writeFile(path.join(root, OUTPUT_MARKDOWN), `${markdown}\n`, 'utf8');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = options.staged
    ? await collectStagedFiles(options.root)
    : await collectRepositoryFiles(options.root);
  const report = analyzeRepository(files);
  const markdown = formatImprovementReportAsMarkdown(report);
  const json = JSON.stringify(report, null, 2);

  if (options.write) {
    await writeBacklogArtifacts(options.root, json, markdown);
  }

  console.log(printSummary(markdown, options.top));

  if (options.failOn && hasFindingsAtOrAboveSeverity(report, options.failOn)) {
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  console.error('[ai-improvement-loop] failed:', error);
  process.exitCode = 1;
});
