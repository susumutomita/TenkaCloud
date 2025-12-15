import {
  EvaluationCategory,
  EvaluationStatus,
  Severity,
  type Prisma,
} from '@prisma/client';
import { prisma } from '../lib/prisma';

// ========== 型定義 ==========

export interface CreateEvaluationCriteriaInput {
  tenantId: string;
  name: string;
  description?: string;
  category: EvaluationCategory;
  weight?: number;
  maxScore?: number;
}

export interface UpdateEvaluationCriteriaInput {
  name?: string;
  description?: string;
  category?: EvaluationCategory;
  weight?: number;
  maxScore?: number;
  isActive?: boolean;
}

export interface ListEvaluationCriteriaOptions {
  page: number;
  limit: number;
  category?: EvaluationCategory;
  isActive?: boolean;
}

export interface CreateScoringSessionInput {
  tenantId: string;
  battleId?: string;
  participantId: string;
}

export interface ListScoringSessionsOptions {
  page: number;
  limit: number;
  battleId?: string;
  participantId?: string;
  status?: EvaluationStatus;
}

export interface TerraformState {
  version: number;
  resources?: TerraformResource[];
}

export interface TerraformResource {
  type: string;
  name?: string;
  instances?: TerraformResourceInstance[];
}

export interface TerraformResourceInstance {
  attributes?: Record<string, unknown>;
}

// ========== 評価基準管理 ==========

export async function createEvaluationCriteria(
  input: CreateEvaluationCriteriaInput
) {
  return prisma.evaluationCriteria.create({
    data: input,
  });
}

export async function getEvaluationCriteria(
  criteriaId: string,
  tenantId: string
) {
  const criteria = await prisma.evaluationCriteria.findUnique({
    where: { id: criteriaId },
    include: { criteriaDetails: true },
  });

  if (!criteria || criteria.tenantId !== tenantId) {
    return null;
  }

  return criteria;
}

export async function listEvaluationCriteria(
  tenantId: string,
  options: ListEvaluationCriteriaOptions
) {
  const { page, limit, category, isActive } = options;
  const skip = (page - 1) * limit;

  const where: Prisma.EvaluationCriteriaWhereInput = { tenantId };
  if (category) {
    where.category = category;
  }
  if (isActive !== undefined) {
    where.isActive = isActive;
  }

  const [data, total] = await Promise.all([
    prisma.evaluationCriteria.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { criteriaDetails: true },
    }),
    prisma.evaluationCriteria.count({ where }),
  ]);

  return { data, total, page, limit };
}

export async function updateEvaluationCriteria(
  criteriaId: string,
  tenantId: string,
  updates: UpdateEvaluationCriteriaInput
) {
  const criteria = await prisma.evaluationCriteria.findUnique({
    where: { id: criteriaId },
  });

  if (!criteria || criteria.tenantId !== tenantId) {
    return null;
  }

  return prisma.evaluationCriteria.update({
    where: { id: criteriaId },
    data: updates,
  });
}

export async function deleteEvaluationCriteria(
  criteriaId: string,
  tenantId: string
) {
  const criteria = await prisma.evaluationCriteria.findUnique({
    where: { id: criteriaId },
  });

  if (!criteria || criteria.tenantId !== tenantId) {
    return;
  }

  await prisma.evaluationCriteria.delete({
    where: { id: criteriaId },
  });
}

// ========== 採点セッション管理 ==========

export async function createScoringSession(input: CreateScoringSessionInput) {
  return prisma.scoringSession.create({
    data: input,
  });
}

export async function getScoringSession(sessionId: string, tenantId: string) {
  const session = await prisma.scoringSession.findUnique({
    where: { id: sessionId },
    include: {
      evaluationItems: {
        include: { criteria: true },
      },
      feedbacks: true,
    },
  });

  if (!session || session.tenantId !== tenantId) {
    return null;
  }

  return session;
}

export async function listScoringSessions(
  tenantId: string,
  options: ListScoringSessionsOptions
) {
  const { page, limit, battleId, participantId, status } = options;
  const skip = (page - 1) * limit;

  const where: Prisma.ScoringSessionWhereInput = { tenantId };
  if (battleId) {
    where.battleId = battleId;
  }
  if (participantId) {
    where.participantId = participantId;
  }
  if (status) {
    where.status = status;
  }

  const [data, total] = await Promise.all([
    prisma.scoringSession.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.scoringSession.count({ where }),
  ]);

  return { data, total, page, limit };
}

// ========== 採点実行 ==========

export async function submitForEvaluation(
  sessionId: string,
  tenantId: string,
  terraformState: TerraformState
) {
  const session = await prisma.scoringSession.findUnique({
    where: { id: sessionId },
  });

  if (!session || session.tenantId !== tenantId) {
    return null;
  }

  if (session.status !== EvaluationStatus.PENDING) {
    throw new Error('評価待ちのセッションのみ提出できます');
  }

  // Terraform State スナップショットを保存
  await prisma.terraformSnapshot.create({
    data: {
      sessionId,
      stateVersion: terraformState.version,
      resourceCount: terraformState.resources?.length ?? 0,
      stateData: terraformState as unknown as Prisma.JsonObject,
    },
  });

  // ステータスを IN_PROGRESS に更新
  return prisma.scoringSession.update({
    where: { id: sessionId },
    data: {
      status: EvaluationStatus.IN_PROGRESS,
      submittedAt: new Date(),
    },
  });
}

export async function evaluateSubmission(sessionId: string, tenantId: string) {
  const session = await prisma.scoringSession.findUnique({
    where: { id: sessionId },
    include: {
      terraformSnapshot: true,
    },
  });

  if (!session || session.tenantId !== tenantId) {
    return null;
  }

  if (session.status !== EvaluationStatus.IN_PROGRESS) {
    throw new Error('評価中のセッションのみ採点できます');
  }

  // テナントの評価基準を取得
  const criteria = await prisma.evaluationCriteria.findMany({
    where: { tenantId, isActive: true },
    include: { criteriaDetails: true },
  });

  const terraformState = session.terraformSnapshot
    ?.stateData as unknown as TerraformState;
  const evaluationResults = evaluateTerraformState(terraformState, criteria);

  // 評価結果を保存
  if (evaluationResults.items.length > 0) {
    await prisma.evaluationItem.createMany({
      data: evaluationResults.items.map((item) => ({
        sessionId,
        criteriaId: item.criteriaId,
        score: item.score,
        maxScore: item.maxScore,
        passed: item.passed,
        actualValue: item.actualValue,
        expectedValue: item.expectedValue,
        details: item.details as Prisma.JsonObject,
      })),
    });
  }

  // フィードバックを保存
  if (evaluationResults.feedbacks.length > 0) {
    await prisma.feedback.createMany({
      data: evaluationResults.feedbacks.map((fb) => ({
        sessionId,
        category: fb.category,
        severity: fb.severity,
        title: fb.title,
        message: fb.message,
        suggestion: fb.suggestion,
        resourceRef: fb.resourceRef,
      })),
    });
  }

  // セッションを完了状態に更新
  return prisma.scoringSession.update({
    where: { id: sessionId },
    data: {
      status: EvaluationStatus.COMPLETED,
      totalScore: evaluationResults.totalScore,
      maxPossibleScore: evaluationResults.maxPossibleScore,
      evaluatedAt: new Date(),
    },
  });
}

// ========== フィードバック取得 ==========

export async function getSessionFeedback(sessionId: string, tenantId: string) {
  const session = await prisma.scoringSession.findUnique({
    where: { id: sessionId },
  });

  if (!session || session.tenantId !== tenantId) {
    return null;
  }

  return prisma.feedback.findMany({
    where: { sessionId },
    orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
  });
}

// ========== ヘルパー関数（テスト用にエクスポート） ==========

interface EvaluationItemResult {
  criteriaId: string;
  score: number;
  maxScore: number;
  passed: boolean;
  actualValue?: string;
  expectedValue?: string;
  details?: Record<string, unknown>;
}

interface FeedbackResult {
  category: EvaluationCategory;
  severity: Severity;
  title: string;
  message: string;
  suggestion?: string;
  resourceRef?: string;
}

interface EvaluationResults {
  items: EvaluationItemResult[];
  feedbacks: FeedbackResult[];
  totalScore: number;
  maxPossibleScore: number;
}

interface CriteriaWithDetails {
  id: string;
  name: string;
  category: EvaluationCategory;
  maxScore: number;
  weight: number;
  criteriaDetails: CriteriaDetail[];
}

interface CriteriaDetail {
  ruleKey: string;
  ruleValue: string;
  points: number;
  severity: Severity;
  description?: string | null;
}

export function evaluateTerraformState(
  state: TerraformState | undefined,
  criteria: CriteriaWithDetails[]
): EvaluationResults {
  const items: EvaluationItemResult[] = [];
  const feedbacks: FeedbackResult[] = [];
  let totalScore = 0;
  let maxPossibleScore = 0;

  for (const criterion of criteria) {
    const result = evaluateCriterion(state, criterion);
    items.push(result.item);
    feedbacks.push(...result.feedbacks);
    totalScore += result.item.score * criterion.weight;
    maxPossibleScore += criterion.maxScore * criterion.weight;
  }

  return { items, feedbacks, totalScore, maxPossibleScore };
}

export function evaluateCriterion(
  state: TerraformState | undefined,
  criterion: CriteriaWithDetails
): { item: EvaluationItemResult; feedbacks: FeedbackResult[] } {
  const feedbacks: FeedbackResult[] = [];
  let score = 0;
  const details: Record<string, unknown> = {};

  for (const detail of criterion.criteriaDetails) {
    const checkResult = checkRule(state, detail.ruleKey, detail.ruleValue);
    details[detail.ruleKey] = checkResult;

    if (checkResult.passed) {
      score += detail.points;
    } else {
      feedbacks.push({
        category: criterion.category,
        severity: detail.severity,
        title: `${criterion.name}: ${detail.ruleKey} チェック失敗`,
        message:
          detail.description ??
          `期待値: ${detail.ruleValue}, 実際値: ${checkResult.actualValue ?? 'なし'}`,
        suggestion: generateSuggestion(detail.ruleKey, detail.ruleValue),
        resourceRef: checkResult.resourceRef,
      });
    }
  }

  return {
    item: {
      criteriaId: criterion.id,
      score,
      maxScore: criterion.maxScore,
      passed: score === criterion.maxScore,
      details,
    },
    feedbacks,
  };
}

interface RuleCheckResult {
  passed: boolean;
  actualValue?: string;
  resourceRef?: string;
}

export function checkRule(
  state: TerraformState | undefined,
  ruleKey: string,
  expectedValue: string
): RuleCheckResult {
  if (!state?.resources) {
    return { passed: false, actualValue: undefined };
  }

  // ルールキーに基づいて評価
  switch (ruleKey) {
    case 'vpc_exists':
      return checkResourceExists(state, 'aws_vpc', expectedValue === 'true');
    case 'vpc_cidr':
      return checkResourceAttribute(
        state,
        'aws_vpc',
        'cidr_block',
        expectedValue
      );
    case 's3_encryption':
      return checkS3Encryption(state, expectedValue === 'true');
    case 'security_group_ssh':
      return checkSecurityGroupSSH(state, expectedValue === 'restricted');
    default:
      return { passed: false, actualValue: 'unknown rule' };
  }
}

export function checkResourceExists(
  state: TerraformState,
  resourceType: string,
  shouldExist: boolean
): RuleCheckResult {
  const exists = state.resources?.some((r) => r.type === resourceType) ?? false;
  return {
    passed: exists === shouldExist,
    actualValue: exists ? 'exists' : 'not exists',
  };
}

export function checkResourceAttribute(
  state: TerraformState,
  resourceType: string,
  attribute: string,
  expectedValue: string
): RuleCheckResult {
  const resource = state.resources?.find((r) => r.type === resourceType);
  if (!resource?.instances?.[0]?.attributes) {
    return { passed: false, actualValue: undefined };
  }

  const actualValue = String(resource.instances[0].attributes[attribute] ?? '');
  return {
    passed: actualValue === expectedValue,
    actualValue,
    resourceRef: `${resourceType}.${resource.name ?? 'unknown'}`,
  };
}

export function checkS3Encryption(
  state: TerraformState,
  shouldBeEncrypted: boolean
): RuleCheckResult {
  const s3Buckets =
    state.resources?.filter((r) => r.type === 'aws_s3_bucket') ?? [];
  if (s3Buckets.length === 0) {
    return { passed: !shouldBeEncrypted, actualValue: 'no s3 buckets' };
  }

  // 簡易チェック: aws_s3_bucket_server_side_encryption_configuration の存在確認
  const encryptionConfigs =
    state.resources?.filter(
      (r) => r.type === 'aws_s3_bucket_server_side_encryption_configuration'
    ) ?? [];

  const allEncrypted = s3Buckets.length <= encryptionConfigs.length;
  return {
    passed: allEncrypted === shouldBeEncrypted,
    actualValue: allEncrypted ? 'encrypted' : 'not encrypted',
  };
}

export function checkSecurityGroupSSH(
  state: TerraformState,
  shouldBeRestricted: boolean
): RuleCheckResult {
  const securityGroups =
    state.resources?.filter((r) => r.type === 'aws_security_group') ?? [];

  for (const sg of securityGroups) {
    const ingress = sg.instances?.[0]?.attributes?.['ingress'] as unknown;
    if (Array.isArray(ingress)) {
      for (const rule of ingress) {
        const ruleObj = rule as Record<string, unknown>;
        if (
          ruleObj['from_port'] === 22 &&
          Array.isArray(ruleObj['cidr_blocks']) &&
          ruleObj['cidr_blocks'].includes('0.0.0.0/0')
        ) {
          return {
            passed: !shouldBeRestricted,
            actualValue: '0.0.0.0/0',
            resourceRef: `aws_security_group.${sg.name ?? 'unknown'}`,
          };
        }
      }
    }
  }

  return {
    passed: shouldBeRestricted,
    actualValue: 'restricted',
  };
}

export function generateSuggestion(
  ruleKey: string,
  expectedValue: string
): string {
  const suggestions: Record<string, string> = {
    vpc_exists: 'VPCを作成してください',
    vpc_cidr: `VPCのCIDRブロックを ${expectedValue} に設定してください`,
    s3_encryption: 'S3バケットのサーバーサイド暗号化を有効にしてください',
    security_group_ssh:
      'SSHポート(22)へのアクセスを特定のIPアドレスに制限してください',
  };

  return suggestions[ruleKey] ?? '設定を見直してください';
}
