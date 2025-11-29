/**
 * Problem Validator
 *
 * JSON Schema を使用した問題定義のバリデーション
 */

import Ajv, { type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import problemSchema from '../schemas/problem.schema.json';
import eventSchema from '../schemas/event.schema.json';
import type { Event, Problem } from '../types';

// Ajv インスタンスの作成
const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  strict: false,
});

// フォーマットバリデーションの追加
addFormats(ajv);

// スキーマのコンパイル
const validateProblemSchema = ajv.compile(problemSchema);
const validateEventSchema = ajv.compile(eventSchema);

/**
 * バリデーションエラー
 */
export interface ValidationError {
  path: string;
  message: string;
  keyword: string;
  params?: Record<string, unknown>;
}

/**
 * バリデーション結果
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * 問題定義のバリデーション
 * @param data 問題データ
 * @returns バリデーション結果
 */
export function validateProblem(data: unknown): ValidationResult {
  const valid = validateProblemSchema(data);

  if (valid) {
    // 追加のビジネスロジックバリデーション
    const problem = data as unknown as Problem;
    const businessErrors = validateProblemBusinessRules(problem);
    if (businessErrors.length > 0) {
      return {
        valid: false,
        errors: businessErrors,
      };
    }

    return { valid: true, errors: [] };
  }

  return {
    valid: false,
    errors: formatAjvErrors(validateProblemSchema.errors || []),
  };
}

/**
 * イベント定義のバリデーション
 * @param data イベントデータ
 * @returns バリデーション結果
 */
export function validateEvent(data: unknown): ValidationResult {
  const valid = validateEventSchema(data);

  if (valid) {
    // 追加のビジネスロジックバリデーション
    const event = data as unknown as Event;
    const businessErrors = validateEventBusinessRules(event);
    if (businessErrors.length > 0) {
      return {
        valid: false,
        errors: businessErrors,
      };
    }

    return { valid: true, errors: [] };
  }

  return {
    valid: false,
    errors: formatAjvErrors(validateEventSchema.errors || []),
  };
}

/**
 * 問題定義のビジネスルールバリデーション
 */
function validateProblemBusinessRules(problem: Problem): ValidationError[] {
  const errors: ValidationError[] = [];

  // 採点基準の重みが100%になるか確認
  const totalWeight = problem.scoring.criteria.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight !== 100) {
    errors.push({
      path: '/scoring/criteria',
      message: `採点基準の重みの合計は100%である必要があります（現在: ${totalWeight}%）`,
      keyword: 'weight-sum',
      params: { totalWeight },
    });
  }

  // デプロイテンプレートが指定されたプロバイダー分存在するか確認
  for (const provider of problem.deployment.providers) {
    if (!problem.deployment.templates[provider]) {
      errors.push({
        path: `/deployment/templates/${provider}`,
        message: `プロバイダー '${provider}' のデプロイテンプレートが定義されていません`,
        keyword: 'required-template',
        params: { provider },
      });
    }
  }

  // リージョンが指定されている場合、対応プロバイダーがあるか確認
  if (problem.deployment.regions) {
    for (const provider of Object.keys(problem.deployment.regions)) {
      if (!problem.deployment.providers.includes(provider as typeof problem.deployment.providers[number])) {
        errors.push({
          path: `/deployment/regions/${provider}`,
          message: `リージョンが指定されたプロバイダー '${provider}' は providers に含まれていません`,
          keyword: 'invalid-provider',
          params: { provider },
        });
      }
    }
  }

  return errors;
}

/**
 * イベント定義のビジネスルールバリデーション
 */
function validateEventBusinessRules(event: Event): ValidationError[] {
  const errors: ValidationError[] = [];

  // 終了時刻が開始時刻より後であることを確認
  if (event.endTime <= event.startTime) {
    errors.push({
      path: '/endTime',
      message: '終了時刻は開始時刻より後である必要があります',
      keyword: 'date-range',
    });
  }

  // チーム参加の場合、チームサイズの設定を確認
  if (event.participantType === 'team') {
    if (!event.minTeamSize || !event.maxTeamSize) {
      errors.push({
        path: '/participantType',
        message: 'チーム参加の場合、minTeamSize と maxTeamSize の設定が必要です',
        keyword: 'team-size-required',
      });
    } else if (event.minTeamSize > event.maxTeamSize) {
      errors.push({
        path: '/minTeamSize',
        message: 'minTeamSize は maxTeamSize 以下である必要があります',
        keyword: 'team-size-range',
      });
    }
  }

  // 注意: 問題の順序バリデーションは EventProblem 関連テーブルで管理するため、
  // ここでは基本的なイベント情報のバリデーションのみを行う

  return errors;
}

/**
 * Ajv エラーを ValidationError 形式に変換
 */
function formatAjvErrors(errors: ErrorObject[]): ValidationError[] {
  return errors.map(error => ({
    path: error.instancePath || '/',
    message: error.message || 'Unknown error',
    keyword: error.keyword,
    params: error.params as Record<string, unknown>,
  }));
}

/**
 * YAML 文字列から問題定義を解析してバリデーション
 * @param yaml YAML文字列
 * @returns バリデーション結果と解析されたデータ
 */
export async function parseAndValidateProblemYaml(yaml: string): Promise<{
  result: ValidationResult;
  data?: Problem;
}> {
  try {
    // 動的インポートで yaml パーサーを読み込み
    const { parse } = await import('yaml');
    const data = parse(yaml);

    const result = validateProblem(data);
    return {
      result,
      data: result.valid ? (data as Problem) : undefined,
    };
  } catch (error) {
    return {
      result: {
        valid: false,
        errors: [{
          path: '/',
          message: `YAML パースエラー: ${error instanceof Error ? error.message : String(error)}`,
          keyword: 'parse-error',
        }],
      },
    };
  }
}

/**
 * YAML 文字列からイベント定義を解析してバリデーション
 * @param yaml YAML文字列
 * @returns バリデーション結果と解析されたデータ
 */
export async function parseAndValidateEventYaml(yaml: string): Promise<{
  result: ValidationResult;
  data?: Event;
}> {
  try {
    const { parse } = await import('yaml');
    const data = parse(yaml);

    const result = validateEvent(data);
    return {
      result,
      data: result.valid ? (data as Event) : undefined,
    };
  } catch (error) {
    return {
      result: {
        valid: false,
        errors: [{
          path: '/',
          message: `YAML パースエラー: ${error instanceof Error ? error.message : String(error)}`,
          keyword: 'parse-error',
        }],
      },
    };
  }
}
