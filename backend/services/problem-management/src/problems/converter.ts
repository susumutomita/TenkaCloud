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
export type ExternalFormat = 'tenkacloud-yaml' | 'tenkacloud-json';

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
 * 問題をエクスポート形式に変換
 */
export function exportProblem(
  problem: Problem,
  options: ExportOptions
): ConversionResult<string> {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    const yamlData = convertToYamlSchema(problem);

    let output: string;
    if (options.format === 'tenkacloud-yaml') {
      output = stringify(yamlData, {
        indent: 2,
        lineWidth: 120,
      });
    } else if (options.format === 'tenkacloud-json') {
      output = options.prettyPrint
        ? JSON.stringify(yamlData, null, 2)
        : JSON.stringify(yamlData);
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
    const yamlData = problems.map((p) => convertToYamlSchema(p));

    let output: string;
    if (options.format === 'tenkacloud-yaml') {
      output = stringify(
        { version: '1.0', problems: yamlData },
        {
          indent: 2,
          lineWidth: 120,
        }
      );
    } else if (options.format === 'tenkacloud-json') {
      const data = { version: '1.0', problems: yamlData };
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
 * 文字列またはオブジェクトから問題をインポート
 */
export function importProblem(
  input: string,
  options: ImportOptions
): ConversionResult<Partial<Problem>> {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
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
 * ファイル拡張子からフォーマットを推測
 */
export function detectFormat(filename: string): ExternalFormat | null {
  const ext = filename.toLowerCase().split('.').pop();
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
