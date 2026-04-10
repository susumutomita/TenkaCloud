import path from 'node:path';

export type DebtSeverity = 'critical' | 'high' | 'medium';

export interface RepositoryFile {
  path: string;
  content: string;
}

export interface DebtFinding {
  ruleId: string;
  title: string;
  category: string;
  severity: DebtSeverity;
  score: number;
  filePath: string;
  line: number;
  summary: string;
  recommendation: string;
}

export interface DebtHotspot {
  filePath: string;
  totalScore: number;
  findingCount: number;
  highestSeverity: DebtSeverity;
}

export interface ImprovementReport {
  findings: DebtFinding[];
  hotspots: DebtHotspot[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    total: number;
  };
  nextActions: string[];
}

interface RuleContext {
  file: RepositoryFile;
  normalizedPath: string;
  lines: string[];
}

interface DebtRule {
  id: string;
  evaluate(context: RuleContext): DebtFinding[];
}

const CODE_FILE_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const DEFAULT_EXCLUDED_SEGMENTS = [
  '/node_modules/',
  '/.next/',
  '/coverage/',
  '/dist/',
  '/build/',
  '/out/',
  '/.git/',
];

const DIRECT_FETCH_APP_PATTERN =
  /^apps\/(?:application-plane|control-plane)\/app\/.+\.(?:ts|tsx|js|jsx)$/;

const ROUTER_PATTERN =
  /^backend\/services\/.+\/src\/(?:api|routes)\/.+\.(?:ts|tsx|js|jsx)$/;

const ALLOWED_AUTH_SKIP_PATTERN =
  /(\/__tests__\/|\.test\.|\/auth(?:\/index)?\.ts$|\/middleware\/auth(?:-middleware)?\.ts$|\/is-auth-skip-enabled\.ts$|\/proxy\.ts$)/;

const DIRECT_SERVICE_ENV_PATTERN =
  /process\.env\.(?:NEXT_PUBLIC_[A-Z0-9_]*API_URL|[A-Z0-9_]*API_URL)/;

const FALLBACK_WARN_PATTERN = /console\.warn\([^)]*fallback/i;
const BAND_AID_PATTERN =
  /(?:console|logger)\.warn\([^)]*(fallback to empty|empty dataset|empty values|stub problem|returning empty)/i;
const TEST_FILE_PATTERN = /(?:\/__tests__\/|\.test\.|\.spec\.)/;

const DIRECT_FETCH_PATTERN = /\bfetch\s*\(/g;

function splitTestBlocks(content: string): string[] {
  return content
    .split(/\b(?:it|test)\s*\(/)
    .slice(1)
    .map((block) => block.trim())
    .filter(Boolean);
}

function severityRank(severity: DebtSeverity): number {
  switch (severity) {
    case 'critical':
      return 3;
    case 'high':
      return 2;
    case 'medium':
      return 1;
  }
}

function compareSeverity(a: DebtSeverity, b: DebtSeverity): DebtSeverity {
  return severityRank(a) >= severityRank(b) ? a : b;
}

function countMatches(content: string, pattern: RegExp): number {
  return [...content.matchAll(pattern)].length;
}

function firstMatchLine(lines: string[], pattern: RegExp): number {
  return (
    lines.findIndex((line) => {
      pattern.lastIndex = 0;
      return pattern.test(line);
    }) + 1 || 1
  );
}

function normalizeFilePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

export function shouldAnalyzeFile(filePath: string): boolean {
  const normalized = normalizeFilePath(filePath);
  if (!CODE_FILE_PATTERN.test(normalized)) {
    return false;
  }

  return !DEFAULT_EXCLUDED_SEGMENTS.some((segment) =>
    normalized.includes(segment),
  );
}

const rules: DebtRule[] = [
  {
    id: 'oversized-module',
    evaluate({ normalizedPath, lines }) {
      if (!CODE_FILE_PATTERN.test(normalizedPath)) {
        return [];
      }

      const lineCount = lines.length;
      if (lineCount < 600) {
        return [];
      }

      const isTestFile = TEST_FILE_PATTERN.test(normalizedPath);
      const severity = lineCount >= 900 ? 'critical' : 'high';
      const score =
        lineCount >= 900 ? (isTestFile ? 10 : 13) : isTestFile ? 6 : 8;
      return [
        {
          ruleId: 'oversized-module',
          title: 'モジュールが大きすぎる',
          category: ROUTER_PATTERN.test(normalizedPath)
            ? 'module-boundary'
            : 'maintainability',
          severity,
          score,
          filePath: normalizedPath,
          line: 1,
          summary: `${lineCount} 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。`,
          recommendation:
            '責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。',
        },
      ];
    },
  },
  {
    id: 'direct-ui-fetch',
    evaluate({ file, normalizedPath, lines }) {
      if (!DIRECT_FETCH_APP_PATTERN.test(normalizedPath)) {
        return [];
      }
      if (normalizedPath.includes('/app/api/')) {
        return [];
      }

      const fetchCount = countMatches(file.content, DIRECT_FETCH_PATTERN);
      if (fetchCount === 0) {
        return [];
      }

      return [
        {
          ruleId: 'direct-ui-fetch',
          title: 'UI レイヤーが直接 fetch している',
          category: 'boundary',
          severity: fetchCount >= 3 ? 'high' : 'medium',
          score: fetchCount >= 3 ? 10 : 6,
          filePath: normalizedPath,
          line: firstMatchLine(lines, /\bfetch\s*\(/),
          summary: `UI ファイル内で fetch を ${fetchCount} 箇所使っており、認証・fallback・例外処理が散りやすい。`,
          recommendation:
            'lib/api または server helper に集約し、UI からはユースケース関数だけを呼ぶ。',
        },
      ];
    },
  },
  {
    id: 'auth-skip-scatter',
    evaluate({ file, normalizedPath, lines }) {
      if (!file.content.includes('AUTH_SKIP')) {
        return [];
      }
      if (ALLOWED_AUTH_SKIP_PATTERN.test(normalizedPath)) {
        return [];
      }

      return [
        {
          ruleId: 'auth-skip-scatter',
          title: 'AUTH_SKIP 判定が責務境界の外へ漏れている',
          category: 'auth',
          severity: 'medium',
          score: 4,
          filePath: normalizedPath,
          line: firstMatchLine(lines, /AUTH_SKIP/),
          summary:
            '認証バイパスの条件分岐が散ると、本番ガードとローカル挙動がファイルごとにずれやすい。',
          recommendation:
            'AUTH_SKIP 判定は shared helper / middleware に閉じ込め、呼び出し側は結果だけを使う。',
        },
      ];
    },
  },
  {
    id: 'route-level-fallback',
    evaluate({ file, normalizedPath, lines }) {
      if (!normalizedPath.includes('/app/api/')) {
        return [];
      }
      if (!FALLBACK_WARN_PATTERN.test(file.content)) {
        return [];
      }

      return [
        {
          ruleId: 'route-level-fallback',
          title: 'route handler に fallback が重複している',
          category: 'fallback',
          severity: 'high',
          score: 9,
          filePath: normalizedPath,
          line: firstMatchLine(lines, /fallback/i),
          summary:
            'route 単位で fallback を持つと、同じエラー条件でも戻り値とログ方針がずれやすい。',
          recommendation:
            'fallback 判定は feature service に寄せ、route handler は HTTP 変換だけに薄く保つ。',
        },
      ];
    },
  },
  {
    id: 'band-aid-fallback',
    evaluate({ file, normalizedPath, lines }) {
      if (
        normalizedPath.includes('/__tests__/') ||
        normalizedPath.includes('.test.')
      ) {
        return [];
      }
      if (!BAND_AID_PATTERN.test(file.content)) {
        return [];
      }

      return [
        {
          ruleId: 'band-aid-fallback',
          title: '一時しのぎの fallback が残っている',
          category: 'correctness',
          severity: 'critical',
          score: 20,
          filePath: normalizedPath,
          line: firstMatchLine(lines, BAND_AID_PATTERN),
          summary:
            'empty dataset / stub を返す実装は障害を隠し、利用者には成功に見えるまま機能不全を固定化する。',
          recommendation:
            '空データで握り潰さず、正しい fallback service を実装するか、未対応として明示的に失敗させる。',
        },
      ];
    },
  },
  {
    id: 'assertion-roulette',
    evaluate({ file, normalizedPath, lines }) {
      if (!TEST_FILE_PATTERN.test(normalizedPath)) {
        return [];
      }

      const maxExpectCount = splitTestBlocks(file.content).reduce(
        (max, block) => Math.max(max, countMatches(block, /\bexpect\s*\(/g)),
        0,
      );
      if (maxExpectCount < 5) {
        return [];
      }

      return [
        {
          ruleId: 'assertion-roulette',
          title: 'アサーションルーレットが発生している',
          category: 'test-quality',
          severity: maxExpectCount >= 8 ? 'high' : 'medium',
          score: maxExpectCount >= 8 ? 8 : 5,
          filePath: normalizedPath,
          line: firstMatchLine(lines, /\b(?:it|test)\s*\(/),
          summary: `単一テストケースに expect が ${maxExpectCount} 個あり、失敗原因が読み取りにくい。`,
          recommendation:
            '観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。',
        },
      ];
    },
  },
  {
    id: 'direct-service-env-read',
    evaluate({ file, normalizedPath, lines }) {
      if (!DIRECT_FETCH_APP_PATTERN.test(normalizedPath)) {
        return [];
      }
      if (!DIRECT_SERVICE_ENV_PATTERN.test(file.content)) {
        return [];
      }

      return [
        {
          ruleId: 'direct-service-env-read',
          title: 'UI がサービス URL を直接参照している',
          category: 'boundary',
          severity: 'high',
          score: 10,
          filePath: normalizedPath,
          line: firstMatchLine(lines, DIRECT_SERVICE_ENV_PATTERN),
          summary:
            'UI が API URL を直接読むと、環境差分と fallback 方針が画面単位で分岐してしまう。',
          recommendation:
            'backend URL の解決は API client/helper に閉じ込め、画面から環境変数参照を排除する。',
        },
      ];
    },
  },
];

export function analyzeRepository(files: RepositoryFile[]): ImprovementReport {
  const findings = files
    .filter((file) => shouldAnalyzeFile(file.path))
    .flatMap((file) => {
      const normalizedPath = normalizeFilePath(file.path);
      const lines = file.content.split(/\r?\n/);
      return rules.flatMap((rule) =>
        rule.evaluate({
          file,
          normalizedPath,
          lines,
        }),
      );
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.filePath.localeCompare(right.filePath);
    });

  const hotspotsByFile = new Map<string, DebtHotspot>();
  for (const finding of findings) {
    const current = hotspotsByFile.get(finding.filePath);
    if (!current) {
      hotspotsByFile.set(finding.filePath, {
        filePath: finding.filePath,
        totalScore: finding.score,
        findingCount: 1,
        highestSeverity: finding.severity,
      });
      continue;
    }

    current.totalScore += finding.score;
    current.findingCount += 1;
    current.highestSeverity = compareSeverity(
      current.highestSeverity,
      finding.severity,
    );
  }

  const hotspots = [...hotspotsByFile.values()].sort((left, right) => {
    if (right.totalScore !== left.totalScore) {
      return right.totalScore - left.totalScore;
    }
    return left.filePath.localeCompare(right.filePath);
  });

  const summary = findings.reduce(
    (accumulator, finding) => {
      accumulator[finding.severity] += 1;
      accumulator.total += 1;
      return accumulator;
    },
    { critical: 0, high: 0, medium: 0, total: 0 },
  );

  const nextActions = findings
    .slice(0, 5)
    .map(
      (finding) =>
        `${finding.filePath}: ${finding.title}。${finding.recommendation}`,
    );

  return {
    findings,
    hotspots,
    summary,
    nextActions,
  };
}

export function formatImprovementReportAsMarkdown(
  report: ImprovementReport,
): string {
  const lines: string[] = [
    '# 技術的負債バックログ',
    '',
    '> このファイルは `scripts/ai-improvement-loop.ts --write` で更新する。',
    '',
    '## サマリー',
    '',
    `- Critical: ${report.summary.critical}`,
    `- High: ${report.summary.high}`,
    `- Medium: ${report.summary.medium}`,
    `- Total: ${report.summary.total}`,
    '',
    '## 優先アクション',
    '',
  ];

  for (const [index, action] of report.nextActions.entries()) {
    lines.push(`${index + 1}. ${action}`);
  }

  lines.push('', '## ホットスポット', '');
  lines.push('| File | Score | Findings | Highest |');
  lines.push('| --- | ---: | ---: | --- |');
  for (const hotspot of report.hotspots.slice(0, 15)) {
    lines.push(
      `| \`${hotspot.filePath}\` | ${hotspot.totalScore} | ${hotspot.findingCount} | ${hotspot.highestSeverity} |`,
    );
  }

  lines.push('', '## Findings', '');
  for (const finding of report.findings) {
    lines.push(`### ${finding.title}`);
    lines.push('');
    lines.push(`- File: \`${finding.filePath}:${finding.line}\``);
    lines.push(`- Severity: ${finding.severity}`);
    lines.push(`- Category: ${finding.category}`);
    lines.push(`- Summary: ${finding.summary}`);
    lines.push(`- Recommendation: ${finding.recommendation}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function hasFindingsAtOrAboveSeverity(
  report: ImprovementReport,
  threshold: DebtSeverity,
): boolean {
  return report.findings.some(
    (finding) => severityRank(finding.severity) >= severityRank(threshold),
  );
}
