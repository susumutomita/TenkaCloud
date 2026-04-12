import path from 'node:path';

export type ArchitectureSeverity = 'error' | 'warning';

export interface ArchitectureFile {
  path: string;
  content: string;
}

export interface ArchitectureFinding {
  ruleId: string;
  severity: ArchitectureSeverity;
  filePath: string;
  line: number;
  summary: string;
  recommendation: string;
}

export interface ArchitectureReport {
  findings: ArchitectureFinding[];
  summary: {
    error: number;
    warning: number;
    total: number;
  };
  nextActions: string[];
}

interface RuleContext {
  file: ArchitectureFile;
  normalizedPath: string;
  lines: string[];
  filesByPath: Map<string, ArchitectureFile>;
}

interface ArchitectureRule {
  id: string;
  evaluate(context: RuleContext): ArchitectureFinding[];
}

const ARCHITECTURE_FILE_PATTERN = /\.(md|ts|tsx|js|jsx|mjs|cjs|tf|hcl)$/;
const REQUIRED_INVARIANTS = [
  'INVARIANT_SERVERLESS_ONLY',
  'INVARIANT_TENANT_IS_COMPANY',
  'INVARIANT_DEPARTMENT_IS_NOT_TENANT',
  'INVARIANT_ONE_APPLICATION_PLANE_PER_TENANT',
  'INVARIANT_CONTROL_PLANE_DOES_NOT_HOST_TENANT_RUNTIME',
  'INVARIANT_PROBLEM_RUNTIME_IN_COMPETITOR_AWS_ACCOUNTS',
  'ONE_PASS_LOCAL',
  'ONE_PASS_AWS',
] as const;

const AUTHORITATIVE_DOCS = [
  'docs/architecture/harness.md',
  'docs/architecture/architecture.md',
  'AGENTS.md',
  'CLAUDE.md',
  'docs/CONTRIBUTING.md',
] as const;

const SERVERFUL_DOC_PATHS = [
  'docs/architecture/architecture.md',
  'docs/architecture/actors.md',
] as const;

export function getArchitectureHarnessAuthoritativePaths(): string[] {
  return [...AUTHORITATIVE_DOCS];
}

function normalizeFilePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function firstMatchLine(lines: string[], pattern: RegExp): number {
  return (
    lines.findIndex((line) => {
      pattern.lastIndex = 0;
      return pattern.test(line);
    }) + 1 || 1
  );
}

export function shouldAnalyzeArchitectureFile(filePath: string): boolean {
  const normalized = normalizeFilePath(filePath);
  if (!ARCHITECTURE_FILE_PATTERN.test(normalized)) {
    return false;
  }

  return ![
    '/node_modules/',
    '/.next/',
    '/coverage/',
    '/dist/',
    '/build/',
    '/out/',
    '/.git/',
  ].some((segment) => normalized.includes(segment));
}

const rules: ArchitectureRule[] = [
  {
    id: 'authoritative-docs-present',
    evaluate({ normalizedPath, file, filesByPath }) {
      if (normalizedPath !== 'docs/architecture/harness.md') {
        return [];
      }

      const findings: ArchitectureFinding[] = [];
      for (const docPath of AUTHORITATIVE_DOCS) {
        if (!filesByPath.has(docPath)) {
          findings.push({
            ruleId: 'authoritative-docs-present',
            severity: 'error',
            filePath: normalizedPath,
            line: 1,
            summary: `正本ドキュメント ${docPath} が harness の検査対象に含まれていない。`,
            recommendation:
              'architecture-harness 実行時は正本ドキュメントを必ず読み込み、原則の欠落を検出できるようにする。',
          });
        }
      }

      if (file.content.includes('## Invariants')) {
        for (const invariant of REQUIRED_INVARIANTS) {
          if (!file.content.includes(invariant)) {
            findings.push({
              ruleId: 'required-invariant-missing',
              severity: 'error',
              filePath: normalizedPath,
              line: 1,
              summary: `architecture harness から ${invariant} が欠落している。`,
              recommendation:
                '原則 ID を docs/architecture/harness.md に明示し、他文書と hook から参照できるようにする。',
            });
          }
        }
      }

      return findings;
    },
  },
  {
    id: 'architecture-doc-links-harness',
    evaluate({ normalizedPath, file, lines }) {
      if (normalizedPath !== 'docs/architecture/architecture.md') {
        return [];
      }

      if (file.content.includes('docs/architecture/harness.md')) {
        return [];
      }

      return [
        {
          ruleId: 'architecture-doc-links-harness',
          severity: 'error',
          filePath: normalizedPath,
          line: 1,
          summary:
            'アーキテクチャ正本が architecture harness を参照しておらず、不変条件の所在が分散する。',
          recommendation:
            'docs/architecture/architecture.md から docs/architecture/harness.md を明示的に参照する。',
        },
      ];
    },
  },
  {
    id: 'agent-guides-run-harness',
    evaluate({ normalizedPath, file, lines }) {
      if (
        normalizedPath !== 'AGENTS.md' &&
        normalizedPath !== 'CLAUDE.md' &&
        normalizedPath !== 'docs/CONTRIBUTING.md'
      ) {
        return [];
      }

      if (
        file.content.includes('bun scripts/architecture-harness.ts --staged')
      ) {
        return [];
      }

      return [
        {
          ruleId: 'agent-guides-run-harness',
          severity: 'error',
          filePath: normalizedPath,
          line: firstMatchLine(lines, /make before-commit/),
          summary:
            'エージェント/コントリビューター向け正本に architecture harness 実行が書かれていない。',
          recommendation:
            'Codex と Claude Code のどちらも同じ pre-commit と手動チェックを辿るよう、bun scripts/architecture-harness.ts --staged を明記する。',
        },
      ];
    },
  },
  {
    id: 'serverful-platform-runtime',
    evaluate({ normalizedPath, file, lines }) {
      if (
        !normalizedPath.startsWith('backend/services/control-plane/') &&
        !normalizedPath.startsWith(
          'backend/services/application-plane/tenant-provisioner/',
        ) &&
        !normalizedPath.startsWith('infrastructure/') &&
        !SERVERFUL_DOC_PATHS.includes(
          normalizedPath as (typeof SERVERFUL_DOC_PATHS)[number],
        )
      ) {
        return [];
      }

      if (
        normalizedPath.startsWith('infrastructure/reference/') ||
        normalizedPath.startsWith('reference/')
      ) {
        return [];
      }

      const pattern =
        /\b(ECS|EKS|Fargate|RDS|NatGateway|NAT Gateway|aws_ecs|aws_eks|aws_db_instance)\b/;
      if (!pattern.test(file.content)) {
        return [];
      }

      const matchingLine = lines.find((line) => {
        pattern.lastIndex = 0;
        if (!pattern.test(line)) {
          return false;
        }

        return !/(禁止|持ち込まない|使わない|ではない|ではなく|not use|must not|do not)/i.test(
          line,
        );
      });
      if (!matchingLine) {
        return [];
      }

      return [
        {
          ruleId: 'serverful-platform-runtime',
          severity: 'error',
          filePath: normalizedPath,
          line: firstMatchLine(
            lines,
            new RegExp(matchingLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          ),
          summary:
            'platform / tenant runtime の正本に serverful 前提が入り込んでいる。',
          recommendation:
            'Control Plane と tenant Application Plane は serverless-only とし、ECS/EKS/RDS/NAT 前提を正本から排除する。',
        },
      ];
    },
  },
  {
    id: 'control-plane-deploys-problem-runtime',
    evaluate({ normalizedPath, file, lines }) {
      if (!normalizedPath.startsWith('backend/services/control-plane/')) {
        return [];
      }

      const pattern =
        /\b(CloudFormationClient|CreateStackCommand|DeleteStackCommand|DescribeStacksCommand|ValidateTemplateCommand|AssumeRoleCommand)\b/;
      if (!pattern.test(file.content)) {
        return [];
      }

      return [
        {
          ruleId: 'control-plane-deploys-problem-runtime',
          severity: 'error',
          filePath: normalizedPath,
          line: firstMatchLine(lines, pattern),
          summary:
            'Control Plane が problem runtime deployment の実行系を持ち込んでいる。',
          recommendation:
            '競技者 AWS アカウントへの AssumeRole + CloudFormation は tenant Application Plane 側へ閉じ込める。',
        },
      ];
    },
  },
];

export function analyzeArchitecture(
  files: ArchitectureFile[],
): ArchitectureReport {
  const filteredFiles = files.filter((file) =>
    shouldAnalyzeArchitectureFile(file.path),
  );
  const filesByPath = new Map(
    filteredFiles.map((file) => [normalizeFilePath(file.path), file]),
  );

  const findings = filteredFiles
    .flatMap((file) => {
      const normalizedPath = normalizeFilePath(file.path);
      const lines = file.content.split(/\r?\n/);
      return rules.flatMap((rule) =>
        rule.evaluate({
          file,
          normalizedPath,
          lines,
          filesByPath,
        }),
      );
    })
    .sort((left, right) => left.filePath.localeCompare(right.filePath));

  const summary = findings.reduce(
    (accumulator, finding) => {
      accumulator[finding.severity] += 1;
      accumulator.total += 1;
      return accumulator;
    },
    { error: 0, warning: 0, total: 0 },
  );

  return {
    findings,
    summary,
    nextActions: findings
      .slice(0, 5)
      .map(
        (finding) =>
          `${finding.filePath}: ${finding.summary} ${finding.recommendation}`,
      ),
  };
}

export function formatArchitectureReportAsMarkdown(
  report: ArchitectureReport,
): string {
  const lines = [
    '# Architecture Harness Report',
    '',
    '## Summary',
    '',
    `- Error: ${report.summary.error}`,
    `- Warning: ${report.summary.warning}`,
    `- Total: ${report.summary.total}`,
    '',
    '## Next Actions',
    '',
    ...report.nextActions.map((action, index) => `${index + 1}. ${action}`),
    '',
    '## Findings',
    '',
  ];

  for (const finding of report.findings) {
    lines.push(`### ${finding.ruleId}`);
    lines.push('');
    lines.push(`- File: \`${finding.filePath}:${finding.line}\``);
    lines.push(`- Severity: ${finding.severity}`);
    lines.push(`- Summary: ${finding.summary}`);
    lines.push(`- Recommendation: ${finding.recommendation}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function hasArchitectureFindingsAtOrAboveSeverity(
  report: ArchitectureReport,
  threshold: ArchitectureSeverity,
): boolean {
  const rank = { warning: 1, error: 2 } satisfies Record<
    ArchitectureSeverity,
    number
  >;
  return report.findings.some(
    (finding) => rank[finding.severity] >= rank[threshold],
  );
}
