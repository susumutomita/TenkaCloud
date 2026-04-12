import { describe, expect, it } from 'vitest';
import {
  analyzeArchitecture,
  formatArchitectureReportAsMarkdown,
  getArchitectureHarnessAuthoritativePaths,
  shouldAnalyzeArchitectureFile,
} from '../architecture-harness';

describe('architecture harness', () => {
  it('docs とコードの対象ファイルだけを分析対象にするべき', () => {
    expect(shouldAnalyzeArchitectureFile('docs/architecture/harness.md')).toBe(
      true,
    );
    expect(
      shouldAnalyzeArchitectureFile(
        'backend/services/control-plane/provisioning/src/handler.ts',
      ),
    ).toBe(true);
    expect(shouldAnalyzeArchitectureFile('docs/image.png')).toBe(false);
  });

  it('authoritative docs に invariant ID が揃っていることを要求するべき', () => {
    const report = analyzeArchitecture([
      {
        path: 'docs/architecture/harness.md',
        content: '# Harness\n\n## Invariants\n\n- `INVARIANT_SERVERLESS_ONLY`',
      },
    ]);

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'authoritative-docs-present',
          severity: 'error',
        }),
        expect.objectContaining({
          ruleId: 'required-invariant-missing',
          severity: 'error',
        }),
      ]),
    );
  });

  it('Control Plane への CloudFormation 実装持ち込みを検出するべき', () => {
    const report = analyzeArchitecture([
      {
        path: 'backend/services/control-plane/deployment-management/src/index.ts',
        content:
          "import { CloudFormationClient, CreateStackCommand } from '@aws-sdk/client-cloudformation';",
      },
    ]);

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        ruleId: 'control-plane-deploys-problem-runtime',
        severity: 'error',
      }),
    );
  });

  it('serverful runtime 前提を検出するべき', () => {
    const report = analyzeArchitecture([
      {
        path: 'docs/architecture/architecture.md',
        content: 'tenant runtime は ECS と RDS で動かす。',
      },
    ]);

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        ruleId: 'serverful-platform-runtime',
        severity: 'error',
      }),
    );
  });

  it('Markdown レポートを出力するべき', () => {
    const report = analyzeArchitecture([
      {
        path: 'AGENTS.md',
        content: '# AGENTS\n\nmake before-commit',
      },
    ]);

    const markdown = formatArchitectureReportAsMarkdown(report);
    expect(markdown).toContain('# Architecture Harness Report');
    expect(markdown).toContain('## Findings');
  });

  it('authoritative paths 一覧を返すべき', () => {
    expect(getArchitectureHarnessAuthoritativePaths()).toEqual(
      expect.arrayContaining([
        'docs/architecture/harness.md',
        'docs/architecture/architecture.md',
        'AGENTS.md',
        'CLAUDE.md',
      ]),
    );
  });
});
