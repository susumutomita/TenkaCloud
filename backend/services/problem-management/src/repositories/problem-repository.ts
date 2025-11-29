/**
 * Prisma Problem Repository
 *
 * PostgreSQL を使用した問題リポジトリ実装
 */

import type {
  Problem as PrismaProblem,
  ProblemType as PrismaProblemType,
  ProblemCategory as PrismaProblemCategory,
  DifficultyLevel as PrismaDifficultyLevel,
  CloudProvider as PrismaCloudProvider,
  MarketplaceListing,
} from '@prisma/client';
import { prisma } from './prisma-client';
import type {
  IProblemRepository,
  IMarketplaceRepository,
  ProblemFilterOptions,
} from '../problems/repository';
import type {
  Problem,
  ProblemType,
  ProblemCategory,
  DifficultyLevel,
  CloudProvider,
  DeploymentTemplate,
  DeploymentTemplateType,
  MarketplaceProblem,
  MarketplaceSearchQuery,
  MarketplaceSearchResult,
} from '../types';

/**
 * Prisma Problem を内部型に変換
 */
function toProblem(
  prismaProblem: PrismaProblem & {
    templates?: { provider: string; type: string; path: string; parameters: unknown }[];
    regions?: { provider: string; regions: string[] }[];
    criteria?: { name: string; description: string | null; weight: number; maxPoints: number }[];
  }
): Problem {
  // テンプレートをプロバイダーごとにグループ化
  const templatesMap: Partial<Record<CloudProvider, DeploymentTemplate>> = {};
  prismaProblem.templates?.forEach((t) => {
    const provider = t.provider.toLowerCase() as CloudProvider;
    templatesMap[provider] = {
      type: t.type as DeploymentTemplateType,
      path: t.path,
      parameters: t.parameters as Record<string, string> | undefined,
    };
  });

  // リージョンをプロバイダーごとにグループ化
  const regionsMap: Partial<Record<CloudProvider, string[]>> = {};
  prismaProblem.regions?.forEach((r) => {
    const provider = r.provider.toLowerCase() as CloudProvider;
    regionsMap[provider] = r.regions;
  });

  return {
    id: prismaProblem.id,
    title: prismaProblem.title,
    type: prismaProblem.type.toLowerCase() as ProblemType,
    category: prismaProblem.category.toLowerCase() as ProblemCategory,
    difficulty: prismaProblem.difficulty.toLowerCase() as DifficultyLevel,
    description: {
      overview: prismaProblem.overview,
      objectives: prismaProblem.objectives,
      hints: prismaProblem.hints,
      prerequisites: prismaProblem.prerequisites,
      estimatedTime: prismaProblem.estimatedTimeMinutes ?? undefined,
    },
    metadata: {
      author: prismaProblem.author,
      version: prismaProblem.version,
      createdAt: prismaProblem.createdAt.toISOString(),
      updatedAt: prismaProblem.updatedAt.toISOString(),
      tags: prismaProblem.tags,
      license: prismaProblem.license ?? undefined,
    },
    deployment: {
      providers: prismaProblem.providers.map(
        (p) => p.toLowerCase() as CloudProvider
      ),
      timeout: prismaProblem.deploymentTimeoutMinutes,
      templates: templatesMap,
      regions: regionsMap,
    },
    scoring: {
      type: prismaProblem.scoringType.toLowerCase() as 'lambda' | 'container' | 'api' | 'manual',
      path: prismaProblem.scoringPath,
      timeoutMinutes: prismaProblem.scoringTimeoutMinutes,
      intervalMinutes: prismaProblem.scoringIntervalMinutes ?? undefined,
      criteria: prismaProblem.criteria?.map((c) => ({
        name: c.name,
        description: c.description ?? '',
        weight: c.weight,
        maxPoints: c.maxPoints,
      })) || [],
    },
  };
}

/**
 * 内部型を Prisma 型に変換
 */
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

function toPrismaDifficulty(difficulty: DifficultyLevel): PrismaDifficultyLevel {
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

/**
 * Prisma Problem Repository 実装
 */
export class PrismaProblemRepository implements IProblemRepository {
  async create(problem: Problem): Promise<Problem> {
    const created = await prisma.problem.create({
      data: {
        externalId: problem.id,
        title: problem.title,
        type: toPrismaType(problem.type),
        category: toPrismaCategory(problem.category),
        difficulty: toPrismaDifficulty(problem.difficulty),
        author: problem.metadata.author,
        version: problem.metadata.version,
        tags: problem.metadata.tags || [],
        license: problem.metadata.license,
        overview: problem.description.overview,
        objectives: problem.description.objectives || [],
        hints: problem.description.hints || [],
        prerequisites: problem.description.prerequisites || [],
        estimatedTimeMinutes: problem.description.estimatedTime,
        providers: problem.deployment.providers.map(toPrismaCloudProvider),
        deploymentTimeoutMinutes: problem.deployment.timeout || 60,
        scoringType: problem.scoring.type.toUpperCase() as 'LAMBDA' | 'CONTAINER' | 'API' | 'MANUAL',
        scoringPath: problem.scoring.path,
        scoringTimeoutMinutes: problem.scoring.timeoutMinutes || 5,
        scoringIntervalMinutes: problem.scoring.intervalMinutes,
      },
      include: {
        templates: true,
        regions: true,
        criteria: true,
      },
    });

    return toProblem(created);
  }

  async update(id: string, updates: Partial<Problem>): Promise<Problem> {
    const data: Record<string, unknown> = {};

    if (updates.title) data.title = updates.title;
    if (updates.type) data.type = toPrismaType(updates.type);
    if (updates.category) data.category = toPrismaCategory(updates.category);
    if (updates.difficulty) data.difficulty = toPrismaDifficulty(updates.difficulty);
    if (updates.description?.overview) data.overview = updates.description.overview;
    if (updates.description?.objectives) data.objectives = updates.description.objectives;
    if (updates.description?.hints) data.hints = updates.description.hints;
    if (updates.description?.prerequisites)
      data.prerequisites = updates.description.prerequisites;
    if (updates.description?.estimatedTime)
      data.estimatedTimeMinutes = updates.description.estimatedTime;
    if (updates.metadata?.author) data.author = updates.metadata.author;
    if (updates.metadata?.version) data.version = updates.metadata.version;
    if (updates.metadata?.tags) data.tags = updates.metadata.tags;
    if (updates.metadata?.license) data.license = updates.metadata.license;
    if (updates.deployment?.providers)
      data.providers = updates.deployment.providers.map(toPrismaCloudProvider);
    if (updates.deployment?.timeout)
      data.deploymentTimeoutMinutes = updates.deployment.timeout;

    const updated = await prisma.problem.update({
      where: { id },
      data,
      include: {
        templates: true,
        regions: true,
        criteria: true,
      },
    });

    return toProblem(updated);
  }

  async delete(id: string): Promise<void> {
    await prisma.problem.delete({
      where: { id },
    });
  }

  async findById(id: string): Promise<Problem | null> {
    const problem = await prisma.problem.findUnique({
      where: { id },
      include: {
        templates: true,
        regions: true,
        criteria: true,
      },
    });

    return problem ? toProblem(problem) : null;
  }

  async findByExternalId(externalId: string): Promise<Problem | null> {
    const problem = await prisma.problem.findUnique({
      where: { externalId },
      include: {
        templates: true,
        regions: true,
        criteria: true,
      },
    });

    return problem ? toProblem(problem) : null;
  }

  async findAll(options?: ProblemFilterOptions): Promise<Problem[]> {
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
    if (options?.author) {
      where.author = options.author;
    }
    if (options?.tags && options.tags.length > 0) {
      where.tags = { hasSome: options.tags };
    }

    const problems = await prisma.problem.findMany({
      where,
      include: {
        templates: true,
        regions: true,
        criteria: true,
      },
      orderBy: { updatedAt: 'desc' },
      skip: options?.offset,
      take: options?.limit,
    });

    return problems.map(toProblem);
  }

  async count(options?: ProblemFilterOptions): Promise<number> {
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

    return prisma.problem.count({ where });
  }

  async exists(id: string): Promise<boolean> {
    const count = await prisma.problem.count({
      where: { id },
    });
    return count > 0;
  }
}

/**
 * Prisma Marketplace Repository 実装
 */
export class PrismaMarketplaceRepository implements IMarketplaceRepository {
  async publish(problemId: string): Promise<MarketplaceProblem> {
    const problem = await prisma.problem.findUnique({
      where: { id: problemId },
      include: {
        templates: true,
        regions: true,
        criteria: true,
      },
    });

    if (!problem) {
      throw new Error(`Problem with id '${problemId}' not found`);
    }

    const listing = await prisma.marketplaceListing.upsert({
      where: { problemId },
      update: {},
      create: {
        problemId,
        publisherId: problem.author,
        publisherName: problem.author,
        isVerified: false,
        isFeatured: false,
      },
      include: {
        problem: {
          include: {
            templates: true,
            regions: true,
            criteria: true,
          },
        },
        reviews: true,
      },
    });

    return this.toMarketplaceProblem(listing);
  }

  async unpublish(marketplaceId: string): Promise<void> {
    await prisma.marketplaceListing.delete({
      where: { id: marketplaceId },
    });
  }

  async search(query: MarketplaceSearchQuery): Promise<MarketplaceSearchResult> {
    const where: Record<string, unknown> = {};

    if (query.query) {
      where.problem = {
        OR: [
          { title: { contains: query.query, mode: 'insensitive' } },
          { overview: { contains: query.query, mode: 'insensitive' } },
          { tags: { hasSome: [query.query.toLowerCase()] } },
        ],
      };
    }
    if (query.type) {
      where.problem = {
        ...where.problem as object,
        type: toPrismaType(query.type),
      };
    }
    if (query.category) {
      where.problem = {
        ...where.problem as object,
        category: toPrismaCategory(query.category),
      };
    }
    if (query.difficulty) {
      where.problem = {
        ...where.problem as object,
        difficulty: toPrismaDifficulty(query.difficulty),
      };
    }
    if (query.provider) {
      where.problem = {
        ...where.problem as object,
        providers: { has: toPrismaCloudProvider(query.provider) },
      };
    }

    let orderBy: Record<string, 'asc' | 'desc'> = { downloadCount: 'desc' };
    switch (query.sortBy) {
      case 'rating':
        orderBy = { averageRating: 'desc' };
        break;
      case 'downloads':
        orderBy = { downloadCount: 'desc' };
        break;
      case 'newest':
        orderBy = { publishedAt: 'desc' };
        break;
    }

    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const [listings, total] = await Promise.all([
      prisma.marketplaceListing.findMany({
        where,
        include: {
          problem: {
            include: {
              templates: true,
              regions: true,
              criteria: true,
            },
          },
          reviews: true,
        },
        orderBy,
        skip,
        take: limit,
      }),
      prisma.marketplaceListing.count({ where }),
    ]);

    return {
      problems: listings.map(this.toMarketplaceProblem),
      total,
      page,
      limit,
      hasMore: skip + limit < total,
    };
  }

  async findById(marketplaceId: string): Promise<MarketplaceProblem | null> {
    const listing = await prisma.marketplaceListing.findUnique({
      where: { id: marketplaceId },
      include: {
        problem: {
          include: {
            templates: true,
            regions: true,
            criteria: true,
          },
        },
        reviews: true,
      },
    });

    return listing ? this.toMarketplaceProblem(listing) : null;
  }

  async incrementDownloads(marketplaceId: string): Promise<void> {
    await prisma.marketplaceListing.update({
      where: { id: marketplaceId },
      data: {
        downloadCount: { increment: 1 },
      },
    });
  }

  async addReview(
    marketplaceId: string,
    review: {
      userId: string;
      userName: string;
      rating: number;
      comment: string;
    }
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.marketplaceReview.create({
        data: {
          listingId: marketplaceId,
          userId: review.userId,
          userName: review.userName,
          rating: review.rating,
          comment: review.comment,
        },
      });

      const reviews = await tx.marketplaceReview.findMany({
        where: { listingId: marketplaceId },
      });

      const avgRating =
        reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;

      await tx.marketplaceListing.update({
        where: { id: marketplaceId },
        data: {
          averageRating: avgRating,
          reviewCount: reviews.length,
        },
      });
    });
  }

  private toMarketplaceProblem(
    listing: MarketplaceListing & {
      problem: PrismaProblem & {
        templates?: { provider: string; type: string; path: string; parameters: unknown }[];
        regions?: { provider: string; regions: string[] }[];
        criteria?: { name: string; description: string | null; weight: number; maxPoints: number }[];
      };
      reviews?: { rating: number }[];
    }
  ): MarketplaceProblem {
    const problem = toProblem(listing.problem);
    return {
      ...problem,
      marketplaceId: listing.id,
      status: 'published',
      publishedAt: listing.publishedAt,
      downloadCount: listing.downloadCount,
      rating: listing.averageRating,
      reviews: listing.reviews?.map((r) => ({
        id: 'review',
        userId: '',
        userName: '',
        rating: r.rating,
        comment: '',
        createdAt: new Date(),
      })) || [],
    };
  }
}

export default PrismaProblemRepository;
