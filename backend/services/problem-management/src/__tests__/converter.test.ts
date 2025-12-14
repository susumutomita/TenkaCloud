/**
 * Converter Tests
 *
 * 問題フォーマット変換の単体テスト
 */

import { describe, it, expect } from 'vitest';
import {
  exportProblem,
  exportProblems,
  importProblem,
  importProblems,
  detectFormat,
} from '../problems/converter';
import type { Problem } from '../types';

// テスト用の問題データ
const createTestProblem = (overrides: Partial<Problem> = {}): Problem => ({
  id: 'test-problem-1',
  title: 'テスト問題',
  type: 'gameday',
  category: 'architecture',
  difficulty: 'medium',
  metadata: {
    author: 'test-author',
    version: '1.0.0',
    createdAt: '2024-01-01',
    updatedAt: '2024-01-02',
    tags: ['aws', 'cloudformation'],
    license: 'MIT',
  },
  description: {
    overview: '# 概要\nこれはテスト問題です。',
    objectives: ['目標1', '目標2'],
    hints: ['ヒント1'],
    prerequisites: ['前提条件1'],
    estimatedTime: 60,
  },
  deployment: {
    providers: ['aws'],
    templates: {
      aws: {
        type: 'cloudformation',
        path: '/templates/aws.yaml',
      },
    },
    regions: {
      aws: ['ap-northeast-1'],
    },
    timeout: 30,
  },
  scoring: {
    type: 'lambda',
    path: '/scoring/index.ts',
    criteria: [
      { name: '基準1', weight: 50, maxPoints: 50 },
      { name: '基準2', weight: 50, maxPoints: 50 },
    ],
    timeoutMinutes: 10,
    intervalMinutes: 5,
  },
  resources: {
    static: [{ path: '/static/file.txt', destination: 's3://bucket/file.txt' }],
    documentation: [{ path: '/docs/README.md' }],
  },
  ...overrides,
});

describe('exportProblem', () => {
  it('YAML 形式でエクスポートできるべき', () => {
    const problem = createTestProblem();
    const result = exportProblem(problem, { format: 'tenkacloud-yaml' });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data).toContain('id: test-problem-1');
    expect(result.data).toContain('title: テスト問題');
    expect(result.data).toContain('type: gameday');
  });

  it('JSON 形式でエクスポートできるべき', () => {
    const problem = createTestProblem();
    const result = exportProblem(problem, { format: 'tenkacloud-json' });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    const parsed = JSON.parse(result.data!);
    expect(parsed.id).toBe('test-problem-1');
    expect(parsed.title).toBe('テスト問題');
  });

  it('prettyPrint オプションで整形された JSON を出力するべき', () => {
    const problem = createTestProblem();
    const result = exportProblem(problem, {
      format: 'tenkacloud-json',
      prettyPrint: true,
    });

    expect(result.success).toBe(true);
    expect(result.data).toContain('\n');
    expect(result.data).toContain('  ');
  });

  it('未対応のフォーマットでエラーを返すべき', () => {
    const problem = createTestProblem();
    const result = exportProblem(problem, {
      format: 'unknown-format' as any,
    });

    expect(result.success).toBe(false);
    expect(result.errors).toContain(
      'Unsupported export format: unknown-format'
    );
  });
});

describe('exportProblems', () => {
  it('複数の問題を YAML 形式でエクスポートできるべき', () => {
    const problems = [
      createTestProblem({ id: 'problem-1', title: '問題1' }),
      createTestProblem({ id: 'problem-2', title: '問題2' }),
    ];
    const result = exportProblems(problems, { format: 'tenkacloud-yaml' });

    expect(result.success).toBe(true);
    expect(result.data).toContain('version: "1.0"');
    expect(result.data).toContain('problems:');
    expect(result.data).toContain('id: problem-1');
    expect(result.data).toContain('id: problem-2');
  });

  it('複数の問題を JSON 形式でエクスポートできるべき', () => {
    const problems = [
      createTestProblem({ id: 'problem-1' }),
      createTestProblem({ id: 'problem-2' }),
    ];
    const result = exportProblems(problems, { format: 'tenkacloud-json' });

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.data!);
    expect(parsed.version).toBe('1.0');
    expect(parsed.problems).toHaveLength(2);
  });
});

describe('importProblem', () => {
  it('YAML 形式からインポートできるべき', () => {
    const yaml = `
id: imported-problem
title: インポートされた問題
type: gameday
category: security
difficulty: hard
metadata:
  author: test-author
  version: "1.0.0"
  createdAt: "2024-01-01"
description:
  overview: 概要テキスト
  objectives:
    - 目標1
deployment:
  providers:
    - aws
  templates:
    aws:
      type: cloudformation
      path: /templates/aws.yaml
scoring:
  type: lambda
  path: /scoring/index.ts
  criteria:
    - name: 基準1
      weight: 100
      maxPoints: 100
  timeoutMinutes: 10
`;

    const result = importProblem(yaml, { format: 'tenkacloud-yaml' });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.id).toBe('imported-problem');
    expect(result.data!.title).toBe('インポートされた問題');
    expect(result.data!.type).toBe('gameday');
  });

  it('JSON 形式からインポートできるべき', () => {
    const json = JSON.stringify({
      id: 'json-problem',
      title: 'JSON 問題',
      type: 'jam',
      category: 'cost',
      difficulty: 'easy',
      metadata: {
        author: 'json-author',
        version: '2.0.0',
        createdAt: '2024-02-01',
      },
      description: {
        overview: 'JSON 概要',
        objectives: ['JSON 目標'],
      },
      deployment: {
        providers: ['gcp'],
        templates: {
          gcp: { type: 'terraform', path: '/templates/gcp.tf' },
        },
      },
      scoring: {
        type: 'container',
        path: '/scoring/Dockerfile',
        criteria: [{ name: '基準', weight: 100, maxPoints: 100 }],
        timeoutMinutes: 15,
      },
    });

    const result = importProblem(json, { format: 'tenkacloud-json' });

    expect(result.success).toBe(true);
    expect(result.data!.id).toBe('json-problem');
    expect(result.data!.type).toBe('jam');
    expect(result.data!.deployment?.providers).toContain('gcp');
  });

  it('必須フィールドがない場合はエラーを返すべき', () => {
    const yaml = `
title: タイトルのみ
`;

    const result = importProblem(yaml, { format: 'tenkacloud-yaml' });

    expect(result.success).toBe(false);
    expect(result.errors).toContain('Missing required field: id');
    expect(result.errors).toContain('Missing required field: type');
  });

  it('不正な YAML でエラーを返すべき', () => {
    const invalidYaml = `
id: test
  invalid: indentation
`;

    const result = importProblem(invalidYaml, { format: 'tenkacloud-yaml' });

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('不正な JSON でエラーを返すべき', () => {
    const invalidJson = '{ invalid json }';

    const result = importProblem(invalidJson, { format: 'tenkacloud-json' });

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('importProblems', () => {
  it('複数の問題を YAML からインポートできるべき', () => {
    const yaml = `
version: "1.0"
problems:
  - id: problem-1
    title: 問題1
    type: gameday
    category: architecture
    difficulty: easy
    metadata:
      author: author1
      version: "1.0.0"
      createdAt: "2024-01-01"
    description:
      overview: 概要1
      objectives:
        - 目標1
    deployment:
      providers:
        - aws
      templates:
        aws:
          type: cloudformation
          path: /templates/1.yaml
    scoring:
      type: lambda
      path: /scoring/1.ts
      criteria:
        - name: 基準1
          weight: 100
          maxPoints: 100
      timeoutMinutes: 10
  - id: problem-2
    title: 問題2
    type: jam
    category: security
    difficulty: hard
    metadata:
      author: author2
      version: "2.0.0"
      createdAt: "2024-02-01"
    description:
      overview: 概要2
      objectives:
        - 目標2
    deployment:
      providers:
        - gcp
      templates:
        gcp:
          type: terraform
          path: /templates/2.tf
    scoring:
      type: container
      path: /scoring/2
      criteria:
        - name: 基準2
          weight: 100
          maxPoints: 100
      timeoutMinutes: 15
`;

    const result = importProblems(yaml, { format: 'tenkacloud-yaml' });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data![0].id).toBe('problem-1');
    expect(result.data![1].id).toBe('problem-2');
  });

  it('problems 配列がない場合はエラーを返すべき', () => {
    const yaml = `
version: "1.0"
`;

    const result = importProblems(yaml, { format: 'tenkacloud-yaml' });

    expect(result.success).toBe(false);
    expect(result.errors).toContain(
      'Invalid format: expected "problems" array'
    );
  });
});

describe('detectFormat', () => {
  it('YAML ファイルを検出できるべき', () => {
    expect(detectFormat('problem.yaml')).toBe('tenkacloud-yaml');
    expect(detectFormat('problem.yml')).toBe('tenkacloud-yaml');
    expect(detectFormat('problem.YAML')).toBe('tenkacloud-yaml');
  });

  it('JSON ファイルを検出できるべき', () => {
    expect(detectFormat('problem.json')).toBe('tenkacloud-json');
    expect(detectFormat('problem.JSON')).toBe('tenkacloud-json');
  });

  it('未対応の拡張子は null を返すべき', () => {
    expect(detectFormat('problem.txt')).toBeNull();
    expect(detectFormat('problem.xml')).toBeNull();
    expect(detectFormat('problem')).toBeNull();
  });
});

describe('ラウンドトリップ', () => {
  it('エクスポートしてインポートしたデータが一致するべき', () => {
    const original = createTestProblem();
    const exported = exportProblem(original, { format: 'tenkacloud-yaml' });
    expect(exported.success).toBe(true);

    const imported = importProblem(exported.data!, {
      format: 'tenkacloud-yaml',
    });
    expect(imported.success).toBe(true);

    // 主要フィールドが一致することを確認
    expect(imported.data!.id).toBe(original.id);
    expect(imported.data!.title).toBe(original.title);
    expect(imported.data!.type).toBe(original.type);
    expect(imported.data!.category).toBe(original.category);
    expect(imported.data!.difficulty).toBe(original.difficulty);
    expect(imported.data!.metadata?.author).toBe(original.metadata.author);
    expect(imported.data!.metadata?.version).toBe(original.metadata.version);
    expect(imported.data!.description?.overview).toBe(
      original.description.overview
    );
    expect(imported.data!.description?.objectives).toEqual(
      original.description.objectives
    );
  });

  it('JSON でもラウンドトリップが成功するべき', () => {
    const original = createTestProblem();
    const exported = exportProblem(original, { format: 'tenkacloud-json' });
    expect(exported.success).toBe(true);

    const imported = importProblem(exported.data!, {
      format: 'tenkacloud-json',
    });
    expect(imported.success).toBe(true);

    expect(imported.data!.id).toBe(original.id);
    expect(imported.data!.title).toBe(original.title);
  });
});
