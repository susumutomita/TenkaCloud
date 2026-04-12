import { describe, expect, it } from 'vitest';
import {
  buildOnePassSummary,
  createOnePassReport,
  formatOnePassReportAsMarkdown,
  getOnePassOverallStatus,
  hasOnePassIssues,
} from '../one-pass-harness';

describe('one-pass harness', () => {
  it('passed と failed と blocked を集計すべき', () => {
    const summary = buildOnePassSummary([
      {
        id: 'step-1',
        label: 'tenant create',
        status: 'passed',
        detail: 'created',
      },
      {
        id: 'step-2',
        label: 'tenant provision',
        status: 'blocked',
        detail: 'not wired',
      },
      {
        id: 'step-3',
        label: 'event create',
        status: 'failed',
        detail: '500',
      },
    ]);

    expect(summary).toEqual({
      passed: 1,
      failed: 1,
      blocked: 1,
      skipped: 0,
    });
  });

  it('failed があれば overall を failed にすべき', () => {
    expect(
      getOnePassOverallStatus([
        {
          id: 'step-1',
          label: 'tenant create',
          status: 'passed',
          detail: 'created',
        },
        {
          id: 'step-2',
          label: 'tenant provision',
          status: 'failed',
          detail: 'failed',
        },
      ]),
    ).toBe('failed');
  });

  it('failed がなく blocked があれば overall を blocked にすべき', () => {
    expect(
      getOnePassOverallStatus([
        {
          id: 'step-1',
          label: 'tenant create',
          status: 'passed',
          detail: 'created',
        },
        {
          id: 'step-2',
          label: 'tenant runtime',
          status: 'blocked',
          detail: 'not connected',
        },
      ]),
    ).toBe('blocked');
  });

  it('問題がなければ overall を passed にすべき', () => {
    expect(
      getOnePassOverallStatus([
        {
          id: 'step-1',
          label: 'tenant create',
          status: 'passed',
          detail: 'created',
        },
      ]),
    ).toBe('passed');
  });

  it('report から issue の有無を返すべき', () => {
    const report = createOnePassReport({
      target: 'local',
      startedAt: '2026-04-12T00:00:00.000Z',
      completedAt: '2026-04-12T00:01:00.000Z',
      steps: [
        {
          id: 'step-1',
          label: 'tenant create',
          status: 'blocked',
          detail: 'not complete',
        },
      ],
    });

    expect(hasOnePassIssues(report)).toBe(true);
  });

  it('Markdown レポートを出力すべき', () => {
    const report = createOnePassReport({
      target: 'local',
      startedAt: '2026-04-12T00:00:00.000Z',
      completedAt: '2026-04-12T00:01:00.000Z',
      steps: [
        {
          id: 'step-1',
          label: 'tenant create',
          status: 'passed',
          detail: 'created',
          hint: 'none',
        },
      ],
    });

    const markdown = formatOnePassReportAsMarkdown(report);
    expect(markdown).toContain('# One-Pass Harness Report');
    expect(markdown).toContain('### step-1 tenant create');
    expect(markdown).toContain('- status: `passed`');
  });
});
