/**
 * DynamoDB Problem Template Repository
 *
 * DynamoDB を使用した問題テンプレートリポジトリ実装
 * 共有パッケージの ProblemTemplateRepository をラップして、
 * problem-service の型に変換するアダプター
 */

import {
  ProblemTemplateRepository as DynamoDBProblemTemplateRepository,
  type ProblemTemplate as DynamoProblemTemplate,
  type CreateProblemTemplateInput as DynamoCreateInput,
  type UpdateProblemTemplateInput as DynamoUpdateInput,
  type ProblemTemplateStatus as DynamoProblemTemplateStatus,
  type ProblemType as DynamoProblemType,
  type ProblemCategory as DynamoProblemCategory,
  type DifficultyLevel as DynamoDifficultyLevel,
  type CloudProvider as DynamoCloudProvider,
  type TemplateType as DynamoTemplateType,
  type ScoringFunctionType as DynamoScoringFunctionType,
} from '@tenkacloud/dynamodb';
import { problemTemplateRepository } from '../lib/dynamodb';
import type {
  ProblemTemplate,
  ProblemTemplateStatus,
  ProblemTemplateVariable,
  ProblemTemplateSearchQuery,
  ProblemTemplateSearchResult,
  ProblemType,
  ProblemCategory,
  DifficultyLevel,
  CloudProvider,
  DeploymentTemplateType,
  ScoringCriterion,
} from '../types';

/**
 * 問題テンプレートリポジトリインターフェース
 */
export interface IProblemTemplateRepository {
  create(
    template: Omit<ProblemTemplate, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<ProblemTemplate>;
  update(
    id: string,
    updates: Partial<ProblemTemplate>
  ): Promise<ProblemTemplate>;
  delete(id: string): Promise<void>;
  findById(id: string): Promise<ProblemTemplate | null>;
  findAll(options?: ProblemTemplateFilterOptions): Promise<ProblemTemplate[]>;
  search(
    query: ProblemTemplateSearchQuery
  ): Promise<ProblemTemplateSearchResult>;
  incrementUsageCount(id: string): Promise<void>;
  count(options?: ProblemTemplateFilterOptions): Promise<number>;
  exists(id: string): Promise<boolean>;
}

export interface ProblemTemplateFilterOptions {
  type?: ProblemType;
  category?: ProblemCategory;
  difficulty?: DifficultyLevel;
  status?: ProblemTemplateStatus;
  author?: string;
  tags?: string[];
  provider?: CloudProvider;
  offset?: number;
  limit?: number;
}

// =============================================================================
// 型変換ユーティリティ (lowercase <-> UPPERCASE)
// =============================================================================

function toDynamoProblemType(type: ProblemType): DynamoProblemType {
  const map: Record<ProblemType, DynamoProblemType> = {
    gameday: 'GAMEDAY',
    jam: 'JAM',
  };
  return map[type];
}

function fromDynamoProblemType(type: DynamoProblemType): ProblemType {
  return type.toLowerCase() as ProblemType;
}

function toDynamoCategory(category: ProblemCategory): DynamoProblemCategory {
  const map: Record<ProblemCategory, DynamoProblemCategory> = {
    architecture: 'ARCHITECTURE',
    security: 'SECURITY',
    cost: 'COST',
    performance: 'PERFORMANCE',
    reliability: 'RELIABILITY',
    operations: 'OPERATIONS',
  };
  return map[category];
}

function fromDynamoCategory(category: DynamoProblemCategory): ProblemCategory {
  return category.toLowerCase() as ProblemCategory;
}

function toDynamoDifficulty(
  difficulty: DifficultyLevel
): DynamoDifficultyLevel {
  const map: Record<DifficultyLevel, DynamoDifficultyLevel> = {
    easy: 'EASY',
    medium: 'MEDIUM',
    hard: 'HARD',
    expert: 'EXPERT',
  };
  return map[difficulty];
}

function fromDynamoDifficulty(
  difficulty: DynamoDifficultyLevel
): DifficultyLevel {
  return difficulty.toLowerCase() as DifficultyLevel;
}

function toDynamoCloudProvider(provider: CloudProvider): DynamoCloudProvider {
  const map: Record<CloudProvider, DynamoCloudProvider> = {
    aws: 'AWS',
    gcp: 'GCP',
    azure: 'AZURE',
    local: 'LOCAL',
  };
  return map[provider];
}

function fromDynamoCloudProvider(provider: DynamoCloudProvider): CloudProvider {
  return provider.toLowerCase() as CloudProvider;
}

function toDynamoTemplateType(
  type: DeploymentTemplateType
): DynamoTemplateType {
  const map: Record<DeploymentTemplateType, DynamoTemplateType> = {
    cloudformation: 'CLOUDFORMATION',
    sam: 'SAM',
    cdk: 'CDK',
    terraform: 'TERRAFORM',
    'deployment-manager': 'DEPLOYMENT_MANAGER',
    arm: 'ARM',
    'docker-compose': 'DOCKER_COMPOSE',
  };
  return map[type];
}

function fromDynamoTemplateType(
  type: DynamoTemplateType
): DeploymentTemplateType {
  const map: Record<DynamoTemplateType, DeploymentTemplateType> = {
    CLOUDFORMATION: 'cloudformation',
    SAM: 'sam',
    CDK: 'cdk',
    TERRAFORM: 'terraform',
    DEPLOYMENT_MANAGER: 'deployment-manager',
    ARM: 'arm',
    DOCKER_COMPOSE: 'docker-compose',
  };
  return map[type];
}

function toDynamoScoringType(
  type: 'lambda' | 'container' | 'api' | 'manual'
): DynamoScoringFunctionType {
  const map: Record<string, DynamoScoringFunctionType> = {
    lambda: 'LAMBDA',
    container: 'CONTAINER',
    api: 'API',
    manual: 'MANUAL',
  };
  return map[type];
}

function fromDynamoScoringType(
  type: DynamoScoringFunctionType
): 'lambda' | 'container' | 'api' | 'manual' {
  return type.toLowerCase() as 'lambda' | 'container' | 'api' | 'manual';
}

function toDynamoTemplateStatus(
  status: ProblemTemplateStatus
): DynamoProblemTemplateStatus {
  const map: Record<ProblemTemplateStatus, DynamoProblemTemplateStatus> = {
    draft: 'DRAFT',
    published: 'PUBLISHED',
    archived: 'ARCHIVED',
  };
  return map[status];
}

function fromDynamoTemplateStatus(
  status: DynamoProblemTemplateStatus
): ProblemTemplateStatus {
  return status.toLowerCase() as ProblemTemplateStatus;
}

/**
 * DynamoDB ProblemTemplate を内部型に変換
 */
function toProblemTemplate(
  dynamoTemplate: DynamoProblemTemplate
): ProblemTemplate {
  return {
    id: dynamoTemplate.id,
    name: dynamoTemplate.name,
    description: dynamoTemplate.description,
    type: fromDynamoProblemType(dynamoTemplate.type),
    category: fromDynamoCategory(dynamoTemplate.category),
    difficulty: fromDynamoDifficulty(dynamoTemplate.difficulty),
    status: fromDynamoTemplateStatus(dynamoTemplate.status),
    variables: dynamoTemplate.variables as ProblemTemplateVariable[],
    descriptionTemplate: {
      overviewTemplate: dynamoTemplate.overviewTemplate,
      objectivesTemplate: dynamoTemplate.objectivesTemplate,
      hintsTemplate: dynamoTemplate.hintsTemplate,
      prerequisites: dynamoTemplate.prerequisites,
      estimatedTime: dynamoTemplate.estimatedTimeMinutes,
    },
    deployment: {
      providers: dynamoTemplate.providers.map(fromDynamoCloudProvider),
      templateType: fromDynamoTemplateType(dynamoTemplate.templateType),
      templateContent: dynamoTemplate.templateContent,
      regions: Object.fromEntries(
        Object.entries(dynamoTemplate.regions).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ])
      ) as Partial<Record<CloudProvider, string[]>>,
      timeout: dynamoTemplate.deploymentTimeout,
    },
    scoring: {
      type: fromDynamoScoringType(dynamoTemplate.scoringType),
      criteriaTemplate: dynamoTemplate.criteriaTemplate as Omit<
        ScoringCriterion,
        'name'
      >[],
      timeoutMinutes: dynamoTemplate.scoringTimeout,
    },
    tags: dynamoTemplate.tags,
    author: dynamoTemplate.author,
    version: dynamoTemplate.version,
    usageCount: dynamoTemplate.usageCount,
    createdAt: dynamoTemplate.createdAt,
    updatedAt: dynamoTemplate.updatedAt,
  };
}

/**
 * DynamoDB Problem Template Repository 実装
 */
export class DynamoProblemTemplateRepository implements IProblemTemplateRepository {
  private repo: DynamoDBProblemTemplateRepository;

  constructor(repo?: DynamoDBProblemTemplateRepository) {
    this.repo = repo ?? problemTemplateRepository;
  }

  async create(
    template: Omit<ProblemTemplate, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<ProblemTemplate> {
    const input: DynamoCreateInput = {
      name: template.name,
      description: template.description,
      type: toDynamoProblemType(template.type),
      category: toDynamoCategory(template.category),
      difficulty: toDynamoDifficulty(template.difficulty),
      overviewTemplate: template.descriptionTemplate.overviewTemplate,
      objectivesTemplate: template.descriptionTemplate.objectivesTemplate,
      hintsTemplate: template.descriptionTemplate.hintsTemplate,
      prerequisites: template.descriptionTemplate.prerequisites,
      estimatedTimeMinutes: template.descriptionTemplate.estimatedTime,
      providers: template.deployment.providers.map(toDynamoCloudProvider),
      templateType: toDynamoTemplateType(template.deployment.templateType),
      templateContent: template.deployment.templateContent,
      regions: template.deployment.regions
        ? Object.fromEntries(
            Object.entries(template.deployment.regions).map(([k, v]) => [
              k.toUpperCase(),
              v,
            ])
          )
        : undefined,
      deploymentTimeout: template.deployment.timeout,
      scoringType: toDynamoScoringType(template.scoring.type),
      criteriaTemplate: template.scoring.criteriaTemplate,
      scoringTimeout: template.scoring.timeoutMinutes,
      tags: template.tags,
      author: template.author,
    };

    const created = await this.repo.create(input);
    return toProblemTemplate(created);
  }

  async update(
    id: string,
    updates: Partial<ProblemTemplate>
  ): Promise<ProblemTemplate> {
    const input: DynamoUpdateInput = {};

    if (updates.name !== undefined) input.name = updates.name;
    if (updates.description !== undefined)
      input.description = updates.description;
    if (updates.status !== undefined)
      input.status = toDynamoTemplateStatus(updates.status);
    if (updates.descriptionTemplate?.overviewTemplate !== undefined)
      input.overviewTemplate = updates.descriptionTemplate.overviewTemplate;
    if (updates.descriptionTemplate?.objectivesTemplate !== undefined)
      input.objectivesTemplate = updates.descriptionTemplate.objectivesTemplate;
    if (updates.descriptionTemplate?.hintsTemplate !== undefined)
      input.hintsTemplate = updates.descriptionTemplate.hintsTemplate;
    if (updates.deployment?.templateContent !== undefined)
      input.templateContent = updates.deployment.templateContent;
    if (updates.scoring?.criteriaTemplate !== undefined)
      input.criteriaTemplate = updates.scoring.criteriaTemplate;
    if (updates.tags !== undefined) input.tags = updates.tags;

    const updated = await this.repo.update(id, input);
    return toProblemTemplate(updated);
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete(id);
  }

  async findById(id: string): Promise<ProblemTemplate | null> {
    const template = await this.repo.findById(id);
    return template ? toProblemTemplate(template) : null;
  }

  async findAll(
    options?: ProblemTemplateFilterOptions
  ): Promise<ProblemTemplate[]> {
    const { templates } = await this.repo.list({
      status: options?.status
        ? toDynamoTemplateStatus(options.status)
        : undefined,
      type: options?.type ? toDynamoProblemType(options.type) : undefined,
      category: options?.category
        ? toDynamoCategory(options.category)
        : undefined,
      difficulty: options?.difficulty
        ? toDynamoDifficulty(options.difficulty)
        : undefined,
      limit: options?.limit,
    });

    let result = templates.map(toProblemTemplate);

    // Additional filtering not supported by DynamoDB repo
    if (options?.author) {
      result = result.filter((t) => t.author === options.author);
    }
    if (options?.tags && options.tags.length > 0) {
      result = result.filter((t) =>
        options.tags!.some((tag) => t.tags.includes(tag))
      );
    }
    if (options?.provider) {
      result = result.filter((t) =>
        t.deployment.providers.includes(options.provider!)
      );
    }

    // Apply offset if provided
    if (options?.offset) {
      result = result.slice(options.offset);
    }

    return result;
  }

  async search(
    query: ProblemTemplateSearchQuery
  ): Promise<ProblemTemplateSearchResult> {
    // Use findAll and filter in memory for search
    const allTemplates = await this.findAll({
      type: query.type,
      category: query.category,
      difficulty: query.difficulty,
      status: query.status,
      provider: query.provider,
      tags: query.tags,
    });

    // Text search filter
    let filtered = allTemplates;
    if (query.query) {
      const searchLower = query.query.toLowerCase();
      filtered = allTemplates.filter(
        (t) =>
          t.name.toLowerCase().includes(searchLower) ||
          t.description.toLowerCase().includes(searchLower) ||
          t.tags.some((tag) => tag.toLowerCase().includes(searchLower))
      );
    }

    // Sorting
    switch (query.sortBy) {
      case 'name':
        filtered.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'usageCount':
        filtered.sort((a, b) => b.usageCount - a.usageCount);
        break;
      case 'newest':
        filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        break;
      case 'updated':
      default:
        filtered.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        break;
    }

    const page = query.page || 1;
    const limit = query.limit || 20;
    const start = (page - 1) * limit;
    const paged = filtered.slice(start, start + limit);

    return {
      templates: paged,
      total: filtered.length,
      page,
      limit,
      hasMore: start + limit < filtered.length,
    };
  }

  async incrementUsageCount(id: string): Promise<void> {
    await this.repo.incrementUsageCount(id);
  }

  async count(options?: ProblemTemplateFilterOptions): Promise<number> {
    return this.repo.count(
      options?.status ? toDynamoTemplateStatus(options.status) : undefined
    );
  }

  async exists(id: string): Promise<boolean> {
    const template = await this.repo.findById(id);
    return template !== null;
  }
}

// Prisma エイリアスとして export（後方互換性）
export { DynamoProblemTemplateRepository as PrismaProblemTemplateRepository };
export default DynamoProblemTemplateRepository;
