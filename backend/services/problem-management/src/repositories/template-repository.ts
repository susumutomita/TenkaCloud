/**
 * Prisma Problem Template Repository
 *
 * PostgreSQL を使用した問題テンプレートリポジトリ実装
 */

import type {
  ProblemTemplate as PrismaProblemTemplate,
  ProblemType as PrismaProblemType,
  ProblemCategory as PrismaProblemCategory,
  DifficultyLevel as PrismaDifficultyLevel,
  CloudProvider as PrismaCloudProvider,
  TemplateType as PrismaTemplateType,
  ScoringFunctionType as PrismaScoringFunctionType,
  ProblemTemplateStatus as PrismaProblemTemplateStatus,
} from '@prisma/client';
import { prisma } from './prisma-client';
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
// 型変換ユーティリティ
// =============================================================================

function toPrismaType(type: ProblemType): PrismaProblemType {
  const map: Record<ProblemType, PrismaProblemType> = {
    gameday: 'GAMEDAY',
    jam: 'JAM',
  };
  return map[type];
}

function toPrismaCategory(category: ProblemCategory): PrismaProblemCategory {
  const map: Record<ProblemCategory, PrismaProblemCategory> = {
    architecture: 'ARCHITECTURE',
    security: 'SECURITY',
    cost: 'COST',
    performance: 'PERFORMANCE',
    reliability: 'RELIABILITY',
    operations: 'OPERATIONS',
  };
  return map[category];
}

function toPrismaDifficulty(
  difficulty: DifficultyLevel
): PrismaDifficultyLevel {
  const map: Record<DifficultyLevel, PrismaDifficultyLevel> = {
    easy: 'EASY',
    medium: 'MEDIUM',
    hard: 'HARD',
    expert: 'EXPERT',
  };
  return map[difficulty];
}

function toPrismaCloudProvider(provider: CloudProvider): PrismaCloudProvider {
  const map: Record<CloudProvider, PrismaCloudProvider> = {
    aws: 'AWS',
    gcp: 'GCP',
    azure: 'AZURE',
    local: 'LOCAL',
  };
  return map[provider];
}

function toPrismaTemplateType(
  type: DeploymentTemplateType
): PrismaTemplateType {
  const map: Record<DeploymentTemplateType, PrismaTemplateType> = {
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

function toPrismaScoringType(
  type: 'lambda' | 'container' | 'api' | 'manual'
): PrismaScoringFunctionType {
  const map: Record<string, PrismaScoringFunctionType> = {
    lambda: 'LAMBDA',
    container: 'CONTAINER',
    api: 'API',
    manual: 'MANUAL',
  };
  return map[type];
}

function toPrismaTemplateStatus(
  status: ProblemTemplateStatus
): PrismaProblemTemplateStatus {
  const map: Record<ProblemTemplateStatus, PrismaProblemTemplateStatus> = {
    draft: 'DRAFT',
    published: 'PUBLISHED',
    archived: 'ARCHIVED',
  };
  return map[status];
}

/**
 * Prisma Problem Template を内部型に変換
 */
function toProblemTemplate(
  prismaTemplate: PrismaProblemTemplate
): ProblemTemplate {
  return {
    id: prismaTemplate.id,
    name: prismaTemplate.name,
    description: prismaTemplate.description,
    type: prismaTemplate.type.toLowerCase() as ProblemType,
    category: prismaTemplate.category.toLowerCase() as ProblemCategory,
    difficulty: prismaTemplate.difficulty.toLowerCase() as DifficultyLevel,
    status: prismaTemplate.status.toLowerCase() as ProblemTemplateStatus,
    variables: prismaTemplate.variables as ProblemTemplateVariable[],
    descriptionTemplate: {
      overviewTemplate: prismaTemplate.overviewTemplate,
      objectivesTemplate: prismaTemplate.objectivesTemplate,
      hintsTemplate: prismaTemplate.hintsTemplate,
      prerequisites: prismaTemplate.prerequisites,
      estimatedTime: prismaTemplate.estimatedTimeMinutes ?? undefined,
    },
    deployment: {
      providers: prismaTemplate.providers.map(
        (p) => p.toLowerCase() as CloudProvider
      ),
      templateType: prismaTemplate.templateType
        .toLowerCase()
        .replace('_', '-') as DeploymentTemplateType,
      templateContent: prismaTemplate.templateContent,
      regions: prismaTemplate.regions as Partial<
        Record<CloudProvider, string[]>
      >,
      timeout: prismaTemplate.deploymentTimeout,
    },
    scoring: {
      type: prismaTemplate.scoringType.toLowerCase() as
        | 'lambda'
        | 'container'
        | 'api'
        | 'manual',
      criteriaTemplate: prismaTemplate.criteriaTemplate as Omit<
        ScoringCriterion,
        'name'
      >[],
      timeoutMinutes: prismaTemplate.scoringTimeout,
    },
    tags: prismaTemplate.tags,
    author: prismaTemplate.author,
    version: prismaTemplate.version,
    usageCount: prismaTemplate.usageCount,
    createdAt: prismaTemplate.createdAt,
    updatedAt: prismaTemplate.updatedAt,
  };
}

/**
 * Prisma Problem Template Repository 実装
 */
export class PrismaProblemTemplateRepository implements IProblemTemplateRepository {
  async create(
    template: Omit<ProblemTemplate, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<ProblemTemplate> {
    const created = await prisma.problemTemplate.create({
      data: {
        name: template.name,
        description: template.description,
        type: toPrismaType(template.type),
        category: toPrismaCategory(template.category),
        difficulty: toPrismaDifficulty(template.difficulty),
        status: toPrismaTemplateStatus(template.status),
        variables: template.variables as unknown as Record<string, unknown>[],
        overviewTemplate: template.descriptionTemplate.overviewTemplate,
        objectivesTemplate: template.descriptionTemplate.objectivesTemplate,
        hintsTemplate: template.descriptionTemplate.hintsTemplate,
        prerequisites: template.descriptionTemplate.prerequisites || [],
        estimatedTimeMinutes: template.descriptionTemplate.estimatedTime,
        providers: template.deployment.providers.map(toPrismaCloudProvider),
        templateType: toPrismaTemplateType(template.deployment.templateType),
        templateContent: template.deployment.templateContent,
        regions: template.deployment.regions || {},
        deploymentTimeout: template.deployment.timeout || 60,
        scoringType: toPrismaScoringType(template.scoring.type),
        criteriaTemplate: template.scoring
          .criteriaTemplate as unknown as Record<string, unknown>[],
        scoringTimeout: template.scoring.timeoutMinutes,
        tags: template.tags,
        author: template.author,
        version: template.version,
        usageCount: template.usageCount || 0,
      },
    });

    return toProblemTemplate(created);
  }

  async update(
    id: string,
    updates: Partial<ProblemTemplate>
  ): Promise<ProblemTemplate> {
    const data: Record<string, unknown> = {};

    if (updates.name !== undefined) data.name = updates.name;
    if (updates.description !== undefined)
      data.description = updates.description;
    if (updates.type !== undefined) data.type = toPrismaType(updates.type);
    if (updates.category !== undefined)
      data.category = toPrismaCategory(updates.category);
    if (updates.difficulty !== undefined)
      data.difficulty = toPrismaDifficulty(updates.difficulty);
    if (updates.status !== undefined)
      data.status = toPrismaTemplateStatus(updates.status);
    if (updates.variables !== undefined) data.variables = updates.variables;
    if (updates.descriptionTemplate?.overviewTemplate !== undefined) {
      data.overviewTemplate = updates.descriptionTemplate.overviewTemplate;
    }
    if (updates.descriptionTemplate?.objectivesTemplate !== undefined) {
      data.objectivesTemplate = updates.descriptionTemplate.objectivesTemplate;
    }
    if (updates.descriptionTemplate?.hintsTemplate !== undefined) {
      data.hintsTemplate = updates.descriptionTemplate.hintsTemplate;
    }
    if (updates.descriptionTemplate?.prerequisites !== undefined) {
      data.prerequisites = updates.descriptionTemplate.prerequisites;
    }
    if (updates.descriptionTemplate?.estimatedTime !== undefined) {
      data.estimatedTimeMinutes = updates.descriptionTemplate.estimatedTime;
    }
    if (updates.deployment?.providers !== undefined) {
      data.providers = updates.deployment.providers.map(toPrismaCloudProvider);
    }
    if (updates.deployment?.templateType !== undefined) {
      data.templateType = toPrismaTemplateType(updates.deployment.templateType);
    }
    if (updates.deployment?.templateContent !== undefined) {
      data.templateContent = updates.deployment.templateContent;
    }
    if (updates.deployment?.regions !== undefined) {
      data.regions = updates.deployment.regions;
    }
    if (updates.deployment?.timeout !== undefined) {
      data.deploymentTimeout = updates.deployment.timeout;
    }
    if (updates.scoring?.type !== undefined) {
      data.scoringType = toPrismaScoringType(updates.scoring.type);
    }
    if (updates.scoring?.criteriaTemplate !== undefined) {
      data.criteriaTemplate = updates.scoring.criteriaTemplate;
    }
    if (updates.scoring?.timeoutMinutes !== undefined) {
      data.scoringTimeout = updates.scoring.timeoutMinutes;
    }
    if (updates.tags !== undefined) data.tags = updates.tags;
    if (updates.author !== undefined) data.author = updates.author;
    if (updates.version !== undefined) data.version = updates.version;

    const updated = await prisma.problemTemplate.update({
      where: { id },
      data,
    });

    return toProblemTemplate(updated);
  }

  async delete(id: string): Promise<void> {
    await prisma.problemTemplate.delete({
      where: { id },
    });
  }

  async findById(id: string): Promise<ProblemTemplate | null> {
    const template = await prisma.problemTemplate.findUnique({
      where: { id },
    });

    return template ? toProblemTemplate(template) : null;
  }

  async findAll(
    options?: ProblemTemplateFilterOptions
  ): Promise<ProblemTemplate[]> {
    const where = this.buildWhereClause(options);

    const templates = await prisma.problemTemplate.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: options?.offset,
      take: options?.limit,
    });

    return templates.map(toProblemTemplate);
  }

  async search(
    query: ProblemTemplateSearchQuery
  ): Promise<ProblemTemplateSearchResult> {
    const where: Record<string, unknown> = {};

    if (query.query) {
      where.OR = [
        { name: { contains: query.query, mode: 'insensitive' } },
        { description: { contains: query.query, mode: 'insensitive' } },
        { tags: { hasSome: [query.query.toLowerCase()] } },
      ];
    }
    if (query.type) {
      where.type = toPrismaType(query.type);
    }
    if (query.category) {
      where.category = toPrismaCategory(query.category);
    }
    if (query.difficulty) {
      where.difficulty = toPrismaDifficulty(query.difficulty);
    }
    if (query.status) {
      where.status = toPrismaTemplateStatus(query.status);
    }
    if (query.provider) {
      where.providers = { has: toPrismaCloudProvider(query.provider) };
    }
    if (query.tags && query.tags.length > 0) {
      where.tags = { hasSome: query.tags };
    }

    let orderBy: Record<string, 'asc' | 'desc'> = { updatedAt: 'desc' };
    switch (query.sortBy) {
      case 'name':
        orderBy = { name: 'asc' };
        break;
      case 'usageCount':
        orderBy = { usageCount: 'desc' };
        break;
      case 'newest':
        orderBy = { createdAt: 'desc' };
        break;
      case 'updated':
        orderBy = { updatedAt: 'desc' };
        break;
    }

    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const [templates, total] = await Promise.all([
      prisma.problemTemplate.findMany({
        where,
        orderBy,
        skip,
        take: limit,
      }),
      prisma.problemTemplate.count({ where }),
    ]);

    return {
      templates: templates.map(toProblemTemplate),
      total,
      page,
      limit,
      hasMore: skip + limit < total,
    };
  }

  async incrementUsageCount(id: string): Promise<void> {
    await prisma.problemTemplate.update({
      where: { id },
      data: {
        usageCount: { increment: 1 },
      },
    });
  }

  async count(options?: ProblemTemplateFilterOptions): Promise<number> {
    const where = this.buildWhereClause(options);
    return prisma.problemTemplate.count({ where });
  }

  async exists(id: string): Promise<boolean> {
    const count = await prisma.problemTemplate.count({
      where: { id },
    });
    return count > 0;
  }

  private buildWhereClause(
    options?: ProblemTemplateFilterOptions
  ): Record<string, unknown> {
    const where: Record<string, unknown> = {};

    if (options?.type) {
      where.type = toPrismaType(options.type);
    }
    if (options?.category) {
      where.category = toPrismaCategory(options.category);
    }
    if (options?.difficulty) {
      where.difficulty = toPrismaDifficulty(options.difficulty);
    }
    if (options?.status) {
      where.status = toPrismaTemplateStatus(options.status);
    }
    if (options?.author) {
      where.author = options.author;
    }
    if (options?.tags && options.tags.length > 0) {
      where.tags = { hasSome: options.tags };
    }
    if (options?.provider) {
      where.providers = { has: toPrismaCloudProvider(options.provider) };
    }

    return where;
  }
}

export default PrismaProblemTemplateRepository;
