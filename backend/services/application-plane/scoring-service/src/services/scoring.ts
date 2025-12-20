import {
  EvaluationCategory,
  EvaluationStatus,
  Severity,
  type ScoringSession,
  type EvaluationCriteria,
  type TerraformSnapshot,
  type EvaluationItemResult,
  type ScoringFeedback,
  type CriteriaDetail,
} from '@tenkacloud/dynamodb';
import {
  scoringSessionRepository,
  evaluationCriteriaRepository,
} from '../lib/dynamodb';

// ========== 型定義 ==========

export interface CreateEvaluationCriteriaInput {
  tenantId: string;
  name: string;
  description?: string;
  category: EvaluationCategory;
  weight?: number;
  maxScore?: number;
  criteriaDetails?: CriteriaDetail[];
}

export interface UpdateEvaluationCriteriaInput {
  name?: string;
  description?: string;
  category?: EvaluationCategory;
  weight?: number;
  maxScore?: number;
  isActive?: boolean;
  criteriaDetails?: CriteriaDetail[];
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
): Promise<EvaluationCriteria> {
  return evaluationCriteriaRepository.create({
    tenantId: input.tenantId,
    name: input.name,
    description: input.description,
    category: input.category,
    weight: input.weight,
    maxScore: input.maxScore,
    criteriaDetails: input.criteriaDetails,
  });
}

export async function getEvaluationCriteria(
  criteriaId: string,
  tenantId: string
): Promise<EvaluationCriteria | null> {
  return evaluationCriteriaRepository.findByIdAndTenant(criteriaId, tenantId);
}

export async function listEvaluationCriteria(
  tenantId: string,
  options: ListEvaluationCriteriaOptions
): Promise<{
  data: EvaluationCriteria[];
  total: number;
  page: number;
  limit: number;
}> {
  const { page, limit, category, isActive } = options;

  const [{ criteria }, total] = await Promise.all([
    evaluationCriteriaRepository.listByTenant(tenantId, {
      category,
      activeOnly: isActive,
      limit,
    }),
    evaluationCriteriaRepository.countByTenant(tenantId, isActive),
  ]);

  return { data: criteria, total, page, limit };
}

export async function updateEvaluationCriteria(
  criteriaId: string,
  tenantId: string,
  updates: UpdateEvaluationCriteriaInput
): Promise<EvaluationCriteria | null> {
  const criteria = await evaluationCriteriaRepository.findByIdAndTenant(
    criteriaId,
    tenantId
  );

  if (!criteria) {
    return null;
  }

  return evaluationCriteriaRepository.update(criteriaId, updates);
}

export async function deleteEvaluationCriteria(
  criteriaId: string,
  tenantId: string
): Promise<void> {
  const criteria = await evaluationCriteriaRepository.findByIdAndTenant(
    criteriaId,
    tenantId
  );

  if (!criteria) {
    return;
  }

  await evaluationCriteriaRepository.delete(criteriaId);
}

// ========== 採点セッション管理 ==========

export async function createScoringSession(
  input: CreateScoringSessionInput
): Promise<ScoringSession> {
  return scoringSessionRepository.create(input);
}

export async function getScoringSession(
  sessionId: string,
  tenantId: string
): Promise<ScoringSession | null> {
  return scoringSessionRepository.findByIdAndTenant(sessionId, tenantId);
}

export async function listScoringSessions(
  tenantId: string,
  options: ListScoringSessionsOptions
): Promise<{
  data: ScoringSession[];
  total: number;
  page: number;
  limit: number;
}> {
  const { page, limit, battleId, participantId, status } = options;

  const [{ sessions }, total] = await Promise.all([
    scoringSessionRepository.listByTenant(tenantId, {
      battleId,
      participantId,
      status,
      limit,
    }),
    scoringSessionRepository.countByTenant(tenantId, status),
  ]);

  return { data: sessions, total, page, limit };
}

// ========== 採点実行 ==========

export async function submitForEvaluation(
  sessionId: string,
  tenantId: string,
  terraformState: TerraformState
): Promise<ScoringSession | null> {
  const session = await scoringSessionRepository.findByIdAndTenant(
    sessionId,
    tenantId
  );

  if (!session) {
    return null;
  }

  if (session.status !== EvaluationStatus.PENDING) {
    throw new Error('評価待ちのセッションのみ提出できます');
  }

  // Terraform State スナップショットを保存してステータスを更新
  const terraformSnapshot: TerraformSnapshot = {
    stateVersion: terraformState.version,
    resourceCount: terraformState.resources?.length ?? 0,
    stateData: terraformState,
  };

  return scoringSessionRepository.update(sessionId, {
    status: EvaluationStatus.IN_PROGRESS,
    submittedAt: new Date(),
    terraformSnapshot,
  });
}

export async function evaluateSubmission(
  sessionId: string,
  tenantId: string
): Promise<ScoringSession | null> {
  const session = await scoringSessionRepository.findByIdAndTenant(
    sessionId,
    tenantId
  );

  if (!session) {
    return null;
  }

  if (session.status !== EvaluationStatus.IN_PROGRESS) {
    throw new Error('評価中のセッションのみ採点できます');
  }

  // テナントの評価基準を取得
  const { criteria } = await evaluationCriteriaRepository.listByTenant(
    tenantId,
    { activeOnly: true }
  );

  const terraformState = session.terraformSnapshot?.stateData as
    | TerraformState
    | undefined;
  const evaluationResults = evaluateTerraformState(terraformState, criteria);

  // セッションを完了状態に更新（評価結果とフィードバックを含む）
  return scoringSessionRepository.update(sessionId, {
    status: EvaluationStatus.COMPLETED,
    totalScore: evaluationResults.totalScore,
    maxPossibleScore: evaluationResults.maxPossibleScore,
    evaluatedAt: new Date(),
    evaluationItems: evaluationResults.items,
    feedbacks: evaluationResults.feedbacks,
  });
}

// ========== フィードバック取得 ==========

export async function getSessionFeedback(
  sessionId: string,
  tenantId: string
): Promise<ScoringFeedback[] | null> {
  const session = await scoringSessionRepository.findByIdAndTenant(
    sessionId,
    tenantId
  );

  if (!session) {
    return null;
  }

  // フィードバックをseverityでソート
  const feedbacks = session.feedbacks ?? [];
  const severityOrder = {
    [Severity.CRITICAL]: 0,
    [Severity.HIGH]: 1,
    [Severity.MEDIUM]: 2,
    [Severity.LOW]: 3,
    [Severity.INFO]: 4,
  };

  return feedbacks.sort(
    (a, b) => severityOrder[a.severity] - severityOrder[b.severity]
  );
}

// ========== ヘルパー関数（テスト用にエクスポート） ==========

interface EvaluationResults {
  items: EvaluationItemResult[];
  feedbacks: ScoringFeedback[];
  totalScore: number;
  maxPossibleScore: number;
}

interface CriteriaWithDetails {
  id: string;
  name: string;
  category: EvaluationCategory;
  maxScore: number;
  weight: number;
  criteriaDetails?: CriteriaDetail[];
}

export function evaluateTerraformState(
  state: TerraformState | undefined,
  criteria: CriteriaWithDetails[]
): EvaluationResults {
  const items: EvaluationItemResult[] = [];
  const feedbacks: ScoringFeedback[] = [];
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
): { item: EvaluationItemResult; feedbacks: ScoringFeedback[] } {
  const feedbacks: ScoringFeedback[] = [];
  let score = 0;
  const details: Record<string, unknown> = {};

  for (const detail of criterion.criteriaDetails ?? []) {
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
