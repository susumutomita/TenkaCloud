/**
 * Problem Format Converter
 *
 * TenkaCloud 問題フォーマットと外部フォーマット間の変換
 */

import { parse, stringify } from 'yaml';
import type {
  Problem,
  ProblemCategory,
  DifficultyLevel,
  CloudProvider,
} from '../types';

/**
 * サポートする外部フォーマット
 */
export type ExternalFormat =
  | 'tenkacloud-yaml'
  | 'tenkacloud-json'
  | 'cloud-contest';

/**
 * 変換結果
 */
export interface ConversionResult<T> {
  success: boolean;
  data?: T;
  errors: string[];
  warnings: string[];
}

/**
 * エクスポートオプション
 */
export interface ExportOptions {
  format: ExternalFormat;
  includeMetadata?: boolean;
  prettyPrint?: boolean;
}

/**
 * インポートオプション
 */
export interface ImportOptions {
  format: ExternalFormat;
  validateSchema?: boolean;
  overwriteExisting?: boolean;
}

/**
 * TenkaCloud YAML 形式のスキーマデータ型
 */
interface TenkaCloudYamlProblem {
  id: string;
  title: string;
  type: 'gameday' | 'jam';
  category: string;
  difficulty: string;
  metadata: {
    author: string;
    version: string;
    createdAt: string;
    updatedAt?: string;
    tags?: string[];
    license?: string;
  };
  description: {
    overview: string;
    objectives: string[];
    hints?: string[];
    prerequisites?: string[];
    estimatedTime?: number;
  };
  deployment: {
    providers: string[];
    templates: Record<
      string,
      { type: string; path: string; parameters?: Record<string, string> }
    >;
    regions?: Record<string, string[]>;
    timeout?: number;
  };
  scoring: {
    type: string;
    path: string;
    criteria: Array<{
      name: string;
      weight: number;
      maxPoints: number;
      description?: string;
    }>;
    timeoutMinutes: number;
    intervalMinutes?: number;
  };
  resources?: {
    static?: Array<{ path: string; destination: string }>;
    documentation?: Array<{ path: string }>;
  };
}

/**
 * Cloud Contest 形式のスキーマデータ型
 */
interface CloudContestProblem {
  version: string;
  challenge: {
    id: string;
    name: string;
    description: string;
    difficulty: string;
    category: string;
    timeLimit?: number;
    points?: number;
  };
  scenario: {
    background: string;
    objectives: string[];
    hints?: string[];
  };
  infrastructure: {
    provider: string;
    region?: string;
    template: {
      type: string;
      path: string;
      parameters?: Record<string, string>;
    };
  };
  scoring: {
    endpoint?: string;
    method: string;
    criteria: Array<{
      id?: string;
      name: string;
      points: number;
      description?: string;
    }>;
    timeout?: number;
  };
  metadata: {
    author: string;
    version: string;
    createdAt: string;
    tags?: string[];
  };
}

/**
 * Cloud Contest difficulty を TenkaCloud difficulty にマッピング
 */
const CLOUD_CONTEST_DIFFICULTY_MAP: Record<string, DifficultyLevel> = {
  beginner: 'easy',
  intermediate: 'medium',
  advanced: 'hard',
  expert: 'expert',
};

/**
 * TenkaCloud difficulty を Cloud Contest difficulty にマッピング
 */
const TENKACLOUD_DIFFICULTY_MAP: Record<DifficultyLevel, string> = {
  easy: 'beginner',
  medium: 'intermediate',
  hard: 'advanced',
  expert: 'expert',
};

/**
 * 問題をエクスポート形式に変換
 */
export function exportProblem(
  problem: Problem,
  options: ExportOptions
): ConversionResult<string> {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    let output: string;

    if (options.format === 'tenkacloud-yaml') {
      const yamlData = convertToYamlSchema(problem);
      output = stringify(yamlData, {
        indent: 2,
        lineWidth: 120,
      });
    } else if (options.format === 'tenkacloud-json') {
      const yamlData = convertToYamlSchema(problem);
      output = options.prettyPrint
        ? JSON.stringify(yamlData, null, 2)
        : JSON.stringify(yamlData);
    } else if (options.format === 'cloud-contest') {
      const cloudContestData = convertToCloudContestSchema(problem);
      output = options.prettyPrint
        ? JSON.stringify(cloudContestData, null, 2)
        : JSON.stringify(cloudContestData);
    } else {
      errors.push(`Unsupported export format: ${options.format}`);
      return { success: false, errors, warnings };
    }

    return { success: true, data: output, errors, warnings };
  } catch (error) {
    errors.push(
      `Export failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return { success: false, errors, warnings };
  }
}

/**
 * 問題を一括エクスポート
 */
export function exportProblems(
  problems: Problem[],
  options: ExportOptions
): ConversionResult<string> {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    let output: string;

    if (options.format === 'tenkacloud-yaml') {
      const yamlData = problems.map((p) => convertToYamlSchema(p));
      output = stringify(
        { version: '1.0', problems: yamlData },
        {
          indent: 2,
          lineWidth: 120,
        }
      );
    } else if (options.format === 'tenkacloud-json') {
      const yamlData = problems.map((p) => convertToYamlSchema(p));
      const data = { version: '1.0', problems: yamlData };
      output = options.prettyPrint
        ? JSON.stringify(data, null, 2)
        : JSON.stringify(data);
    } else if (options.format === 'cloud-contest') {
      const cloudContestData = problems.map((p) =>
        convertToCloudContestSchema(p)
      );
      const data = { version: '2.0', challenges: cloudContestData };
      output = options.prettyPrint
        ? JSON.stringify(data, null, 2)
        : JSON.stringify(data);
    } else {
      errors.push(`Unsupported export format: ${options.format}`);
      return { success: false, errors, warnings };
    }

    return { success: true, data: output, errors, warnings };
  } catch (error) {
    errors.push(
      `Export failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return { success: false, errors, warnings };
  }
}

/**
 * エクスポート用の YAML スキーマ形式に変換
 */
function convertToYamlSchema(problem: Problem): TenkaCloudYamlProblem {
  return {
    id: problem.id,
    title: problem.title,
    type: problem.type as 'gameday' | 'jam',
    category: problem.category,
    difficulty: problem.difficulty,
    metadata: {
      author: problem.metadata.author,
      version: problem.metadata.version,
      createdAt: problem.metadata.createdAt,
      updatedAt: problem.metadata.updatedAt,
      tags: problem.metadata.tags,
      license: problem.metadata.license,
    },
    description: {
      overview: problem.description.overview,
      objectives: problem.description.objectives,
      hints: problem.description.hints,
      prerequisites: problem.description.prerequisites,
      estimatedTime: problem.description.estimatedTime,
    },
    deployment: {
      providers: problem.deployment.providers,
      templates: problem.deployment.templates as Record<
        string,
        { type: string; path: string }
      >,
      regions: problem.deployment.regions,
      timeout: problem.deployment.timeout,
    },
    scoring: {
      type: problem.scoring.type,
      path: problem.scoring.path,
      criteria: problem.scoring.criteria,
      timeoutMinutes: problem.scoring.timeoutMinutes,
      intervalMinutes: problem.scoring.intervalMinutes,
    },
    resources: problem.resources,
  };
}

/**
 * エクスポート用の Cloud Contest スキーマ形式に変換
 */
function convertToCloudContestSchema(problem: Problem): CloudContestProblem {
  const provider = problem.deployment.providers[0] ?? 'aws';
  const template = problem.deployment.templates[provider];
  const totalPoints = problem.scoring.criteria.reduce(
    (sum, c) => sum + c.maxPoints,
    0
  );

  return {
    version: '2.0',
    challenge: {
      id: problem.id,
      name: problem.title,
      description: problem.description.overview,
      difficulty:
        TENKACLOUD_DIFFICULTY_MAP[problem.difficulty as DifficultyLevel] ??
        problem.difficulty,
      category: problem.category,
      timeLimit: (problem.scoring.timeoutMinutes ?? 10) * 60,
      points: totalPoints,
    },
    scenario: {
      background: problem.description.overview,
      objectives: problem.description.objectives,
      hints: problem.description.hints,
    },
    infrastructure: {
      provider,
      region: problem.deployment.regions?.[provider]?.[0],
      template: {
        type: template?.type ?? 'cloudformation',
        path: template?.path ?? '',
        parameters: template?.parameters,
      },
    },
    scoring: {
      endpoint:
        problem.scoring.type === 'api' ? problem.scoring.path : undefined,
      method: problem.scoring.type,
      criteria: problem.scoring.criteria.map((c, index) => ({
        id: `criterion-${index}`,
        name: c.name,
        points: c.maxPoints,
        description: c.description,
      })),
      timeout: (problem.scoring.timeoutMinutes ?? 10) * 60,
    },
    metadata: {
      author: problem.metadata.author,
      version: problem.metadata.version,
      createdAt: problem.metadata.createdAt,
      tags: problem.metadata.tags,
    },
  };
}

/**
 * 文字列またはオブジェクトから問題をインポート
 */
export function importProblem(
  input: string,
  options: ImportOptions
): ConversionResult<Partial<Problem>> {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    if (options.format === 'cloud-contest') {
      const parsed = JSON.parse(input) as CloudContestProblem;

      // 基本バリデーション
      if (!parsed.challenge?.id) {
        errors.push('Missing required field: challenge.id');
      }
      if (!parsed.challenge?.name) {
        errors.push('Missing required field: challenge.name');
      }

      if (errors.length > 0) {
        return { success: false, errors, warnings };
      }

      const problem = convertFromCloudContestSchema(parsed);
      return { success: true, data: problem, errors, warnings };
    }

    let parsed: TenkaCloudYamlProblem;

    if (options.format === 'tenkacloud-yaml') {
      parsed = parse(input) as TenkaCloudYamlProblem;
    } else if (options.format === 'tenkacloud-json') {
      parsed = JSON.parse(input) as TenkaCloudYamlProblem;
    } else {
      errors.push(`Unsupported import format: ${options.format}`);
      return { success: false, errors, warnings };
    }

    // 基本バリデーション
    if (!parsed.id) {
      errors.push('Missing required field: id');
    }
    if (!parsed.title) {
      errors.push('Missing required field: title');
    }
    if (!parsed.type) {
      errors.push('Missing required field: type');
    }

    if (errors.length > 0) {
      return { success: false, errors, warnings };
    }

    const problem = convertFromYamlSchema(parsed);

    return { success: true, data: problem, errors, warnings };
  } catch (error) {
    errors.push(
      `Import failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return { success: false, errors, warnings };
  }
}

/**
 * 文字列から複数の問題をインポート
 */
export function importProblems(
  input: string,
  options: ImportOptions
): ConversionResult<Partial<Problem>[]> {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    if (options.format === 'cloud-contest') {
      const parsed = JSON.parse(input) as {
        version?: string;
        challenges: CloudContestProblem[];
      };

      if (!parsed.challenges || !Array.isArray(parsed.challenges)) {
        errors.push('Invalid format: expected "challenges" array');
        return { success: false, errors, warnings };
      }

      const problems = parsed.challenges
        .map((p, index) => {
          try {
            return convertFromCloudContestSchema(p);
          } catch (e) {
            warnings.push(
              `Challenge at index ${index} conversion failed: ${e}`
            );
            return null;
          }
        })
        .filter((p): p is Partial<Problem> => p !== null);

      return { success: true, data: problems, errors, warnings };
    }

    let parsed: { version?: string; problems: TenkaCloudYamlProblem[] };

    if (options.format === 'tenkacloud-yaml') {
      parsed = parse(input) as {
        version?: string;
        problems: TenkaCloudYamlProblem[];
      };
    } else if (options.format === 'tenkacloud-json') {
      parsed = JSON.parse(input) as {
        version?: string;
        problems: TenkaCloudYamlProblem[];
      };
    } else {
      errors.push(`Unsupported import format: ${options.format}`);
      return { success: false, errors, warnings };
    }

    if (!parsed.problems || !Array.isArray(parsed.problems)) {
      errors.push('Invalid format: expected "problems" array');
      return { success: false, errors, warnings };
    }

    const problems = parsed.problems
      .map((p, index) => {
        try {
          return convertFromYamlSchema(p);
        } catch (e) {
          warnings.push(`Problem at index ${index} conversion failed: ${e}`);
          return null;
        }
      })
      .filter((p): p is Partial<Problem> => p !== null);

    return { success: true, data: problems, errors, warnings };
  } catch (error) {
    errors.push(
      `Import failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return { success: false, errors, warnings };
  }
}

/**
 * YAML スキーマ形式から Problem 型に変換
 */
function convertFromYamlSchema(yaml: TenkaCloudYamlProblem): Partial<Problem> {
  return {
    id: yaml.id,
    title: yaml.title,
    type: yaml.type,
    category: yaml.category as ProblemCategory,
    difficulty: yaml.difficulty as DifficultyLevel,
    metadata: {
      author: yaml.metadata.author,
      version: yaml.metadata.version,
      createdAt: yaml.metadata.createdAt,
      updatedAt: yaml.metadata.updatedAt,
      tags: yaml.metadata.tags ?? [],
      license: yaml.metadata.license,
    },
    description: {
      overview: yaml.description.overview,
      objectives: yaml.description.objectives,
      hints: yaml.description.hints ?? [],
      prerequisites: yaml.description.prerequisites,
      estimatedTime: yaml.description.estimatedTime,
    },
    deployment: {
      providers: yaml.deployment.providers as CloudProvider[],
      templates: yaml.deployment.templates,
      regions: yaml.deployment.regions ?? {},
      timeout: yaml.deployment.timeout,
    },
    scoring: {
      type: yaml.scoring.type as 'lambda' | 'container' | 'api' | 'manual',
      path: yaml.scoring.path,
      criteria: yaml.scoring.criteria,
      timeoutMinutes: yaml.scoring.timeoutMinutes,
      intervalMinutes: yaml.scoring.intervalMinutes,
    },
    resources: yaml.resources,
  };
}

/**
 * Cloud Contest スキーマ形式から Problem 型に変換
 */
function convertFromCloudContestSchema(
  cloudContest: CloudContestProblem
): Partial<Problem> {
  const provider = (cloudContest.infrastructure?.provider ??
    'aws') as CloudProvider;
  const difficulty =
    CLOUD_CONTEST_DIFFICULTY_MAP[cloudContest.challenge.difficulty] ??
    (cloudContest.challenge.difficulty as DifficultyLevel);

  return {
    id: cloudContest.challenge.id,
    title: cloudContest.challenge.name,
    type: 'gameday',
    category: cloudContest.challenge.category as ProblemCategory,
    difficulty,
    metadata: {
      author: cloudContest.metadata?.author ?? 'Unknown',
      version: cloudContest.metadata?.version ?? '1.0.0',
      createdAt: cloudContest.metadata?.createdAt ?? new Date().toISOString(),
      tags: cloudContest.metadata?.tags ?? [],
    },
    description: {
      overview:
        cloudContest.scenario?.background ?? cloudContest.challenge.description,
      objectives: cloudContest.scenario?.objectives ?? [],
      hints: cloudContest.scenario?.hints ?? [],
    },
    deployment: {
      providers: [provider],
      templates: {
        [provider]: {
          type: cloudContest.infrastructure?.template?.type ?? 'cloudformation',
          path: cloudContest.infrastructure?.template?.path ?? '',
          parameters: cloudContest.infrastructure?.template?.parameters,
        },
      },
      regions: cloudContest.infrastructure?.region
        ? { [provider]: [cloudContest.infrastructure.region] }
        : {},
    },
    scoring: {
      type: (cloudContest.scoring?.method ?? 'api') as
        | 'lambda'
        | 'container'
        | 'api'
        | 'manual',
      path: cloudContest.scoring?.endpoint ?? '',
      criteria: (cloudContest.scoring?.criteria ?? []).map((c) => ({
        name: c.name,
        weight: c.points,
        maxPoints: c.points,
        description: c.description,
      })),
      timeoutMinutes: Math.ceil((cloudContest.scoring?.timeout ?? 600) / 60),
    },
  };
}

/**
 * ファイル拡張子からフォーマットを推測
 */
export function detectFormat(filename: string): ExternalFormat | null {
  const lowerFilename = filename.toLowerCase();

  // Cloud Contest 形式の検出 (.cloudcontest.json または .cc.json)
  if (
    lowerFilename.endsWith('.cloudcontest.json') ||
    lowerFilename.endsWith('.cc.json')
  ) {
    return 'cloud-contest';
  }

  const ext = lowerFilename.split('.').pop();
  switch (ext) {
    case 'yaml':
    case 'yml':
      return 'tenkacloud-yaml';
    case 'json':
      return 'tenkacloud-json';
    default:
      return null;
  }
}
