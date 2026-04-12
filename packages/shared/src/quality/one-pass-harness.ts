export type OnePassTarget = 'local' | 'aws';
export type OnePassStepStatus = 'passed' | 'failed' | 'blocked' | 'skipped';

export interface OnePassStepResult {
  id: string;
  label: string;
  status: OnePassStepStatus;
  detail: string;
  hint?: string;
}

export interface OnePassSummary {
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
}

export interface OnePassReport {
  target: OnePassTarget;
  startedAt: string;
  completedAt: string;
  summary: OnePassSummary;
  steps: OnePassStepResult[];
  overallStatus: 'passed' | 'failed' | 'blocked';
}

export function buildOnePassSummary(
  steps: OnePassStepResult[],
): OnePassSummary {
  return steps.reduce<OnePassSummary>(
    (summary, step) => {
      if (step.status === 'passed') summary.passed += 1;
      if (step.status === 'failed') summary.failed += 1;
      if (step.status === 'blocked') summary.blocked += 1;
      if (step.status === 'skipped') summary.skipped += 1;
      return summary;
    },
    { passed: 0, failed: 0, blocked: 0, skipped: 0 },
  );
}

export function getOnePassOverallStatus(
  steps: OnePassStepResult[],
): OnePassReport['overallStatus'] {
  if (steps.some((step) => step.status === 'failed')) {
    return 'failed';
  }

  if (steps.some((step) => step.status === 'blocked')) {
    return 'blocked';
  }

  return 'passed';
}

export function createOnePassReport(input: {
  target: OnePassTarget;
  startedAt: string;
  completedAt: string;
  steps: OnePassStepResult[];
}): OnePassReport {
  return {
    ...input,
    summary: buildOnePassSummary(input.steps),
    overallStatus: getOnePassOverallStatus(input.steps),
  };
}

export function hasOnePassIssues(report: OnePassReport): boolean {
  return report.overallStatus !== 'passed';
}

export function formatOnePassReportAsMarkdown(report: OnePassReport): string {
  const lines = [
    '# One-Pass Harness Report',
    '',
    `- target: \`${report.target}\``,
    `- overall: \`${report.overallStatus}\``,
    `- startedAt: \`${report.startedAt}\``,
    `- completedAt: \`${report.completedAt}\``,
    '',
    '## Summary',
    '',
    `- passed: ${report.summary.passed}`,
    `- failed: ${report.summary.failed}`,
    `- blocked: ${report.summary.blocked}`,
    `- skipped: ${report.summary.skipped}`,
    '',
    '## Steps',
    '',
  ];

  for (const step of report.steps) {
    lines.push(
      `### ${step.id} ${step.label}`,
      '',
      `- status: \`${step.status}\``,
      `- detail: ${step.detail}`,
    );

    if (step.hint) {
      lines.push(`- hint: ${step.hint}`);
    }

    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
