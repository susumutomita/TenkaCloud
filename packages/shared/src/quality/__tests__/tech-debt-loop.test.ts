import { describe, expect, it } from 'vitest';
import {
  analyzeRepository,
  formatImprovementReportAsMarkdown,
  shouldAnalyzeFile,
} from '../tech-debt-loop';

describe('tech debt loop', () => {
  it('コードファイルのみを分析対象にするべき', () => {
    expect(shouldAnalyzeFile('apps/application-plane/app/page.tsx')).toBe(true);
    expect(shouldAnalyzeFile('docs/README.md')).toBe(false);
    expect(
      shouldAnalyzeFile('apps/application-plane/node_modules/react/index.js'),
    ).toBe(false);
  });

  it('巨大モジュールを critical hotspot として検出するべき', () => {
    const oversizedContent = new Array(920)
      .fill('export const x = 1;')
      .join('\n');
    const report = analyzeRepository([
      {
        path: 'backend/services/application-plane/problem-service/src/routes/admin.ts',
        content: oversizedContent,
      },
    ]);

    expect(report.summary.critical).toBe(1);
    expect(report.hotspots[0]).toMatchObject({
      filePath:
        'backend/services/application-plane/problem-service/src/routes/admin.ts',
      highestSeverity: 'critical',
    });
  });

  it('UI の直接 fetch と API URL 直参照を優先課題として検出するべき', () => {
    const report = analyzeRepository([
      {
        path: 'apps/application-plane/app/(participant)/gameday/[eventId]/vote/page.tsx',
        content: `
const api = process.env.NEXT_PUBLIC_GAMEDAY_API_URL;
await fetch('/api/one');
await fetch('/api/two');
await fetch(api || '/api/three');
        `,
      },
    ]);

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'direct-ui-fetch',
          severity: 'high',
        }),
        expect.objectContaining({ ruleId: 'direct-service-env-read' }),
      ]),
    );
    expect(report.hotspots[0]?.totalScore).toBeGreaterThanOrEqual(17);
  });

  it('route handler の fallback 重複を検出するべき', () => {
    const report = analyzeRepository([
      {
        path: 'apps/application-plane/app/api/admin/events/route.ts',
        content: `
try {
  return Response.json({});
} catch (error) {
  console.warn('Admin events fallback to empty dataset:', error);
  return Response.json([]);
}
        `,
      },
    ]);

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        ruleId: 'route-level-fallback',
        severity: 'high',
      }),
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        ruleId: 'band-aid-fallback',
        severity: 'critical',
      }),
    );
  });

  it('アサーションルーレットを検出するべき', () => {
    const report = analyzeRepository([
      {
        path: 'apps/application-plane/app/(participant)/gameday/[eventId]/vote/__tests__/page.test.tsx',
        content: `
describe('vote', () => {
  it('投票できるべき', () => {
    expect(1).toBe(1);
    expect(2).toBe(2);
    expect(3).toBe(3);
    expect(4).toBe(4);
    expect(5).toBe(5);
    expect(6).toBe(6);
  });
});
        `,
      },
    ]);

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        ruleId: 'assertion-roulette',
      }),
    );
  });

  it('Markdown レポートに優先アクションと findings を出力するべき', () => {
    const report = analyzeRepository([
      {
        path: 'apps/control-plane/app/dashboard/page.tsx',
        content: `
const api = process.env.NEXT_PUBLIC_CONTROL_API_URL;
await fetch('/api/dashboard');
        `,
      },
    ]);

    const markdown = formatImprovementReportAsMarkdown(report);

    expect(markdown).toContain('# 技術的負債バックログ');
    expect(markdown).toContain('## 優先アクション');
    expect(markdown).toContain('UI レイヤーが直接 fetch している');
  });
});
