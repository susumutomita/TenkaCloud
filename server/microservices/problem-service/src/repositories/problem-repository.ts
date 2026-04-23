/**
 * Prisma Problem Repository
 *
 * PostgreSQL を使用した問題リポジトリ実装
 */

import { prisma as _prisma } from "./prisma-client";
import type {
	IProblemRepository,
	ProblemFilterOptions,
} from "../problems/repository";
// DynamoProblemRepository is not yet implemented — tracked in issue #392
import type {
	Problem,
	CloudProvider,
} from "../types";
import {
	toProblem,
	toPrismaType,
	toPrismaCategory,
	toPrismaDifficulty,
	toPrismaCloudProvider,
	toPrismaTemplateType,
} from "./problem-mapper";

function shouldUseDynamoProblemRepository(): boolean {
	switch (process.env.PROBLEM_REPOSITORY_DRIVER) {
		case "dynamodb":
			return true;
		case "prisma":
			return false;
		default:
			return process.env.NODE_ENV !== "test" && !process.env.DATABASE_URL;
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getPrisma(): any {
	if (!_prisma) {
		throw new Error(
			'Prisma client is not available. Run "bunx prisma generate" or use DynamoDB-based repositories.',
		);
	}
	return _prisma;
}

/**
 * Prisma Problem Repository 実装
 */
export class PrismaProblemRepository implements IProblemRepository {
	private readonly delegate: IProblemRepository | null;

	constructor() {
		// DynamoProblemRepository is not yet implemented; always use Prisma for now
		this.delegate = null;
	}

	async create(problem: Problem): Promise<Problem> {
		if (this.delegate) {
			return this.delegate.create(problem);
		}

		const created = await getPrisma().problem.create({
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
				scoringType: problem.scoring.type.toUpperCase() as
					| "LAMBDA"
					| "CONTAINER"
					| "API"
					| "MANUAL",
				scoringPath: problem.scoring.path,
				scoringTimeoutMinutes: problem.scoring.timeoutMinutes || 5,
				scoringIntervalMinutes: problem.scoring.intervalMinutes,
				templates: {
					create: Object.entries(problem.deployment.templates || {}).map(
						([provider, t]) => ({
							provider: toPrismaCloudProvider(provider as CloudProvider),
							type: toPrismaTemplateType(t.type),
							path: t.path ?? null,
							content: t.content ?? null,
							parameters: t.parameters ?? {},
						}),
					),
				},
				regions: {
					create: Object.entries(problem.deployment.regions || {}).map(
						([provider, regions]) => ({
							provider: toPrismaCloudProvider(provider as CloudProvider),
							regions: regions ?? [],
						}),
					),
				},
				criteria: {
					create: (problem.scoring.criteria || []).map((c, i) => ({
						name: c.name,
						description: c.description ?? null,
						weight: c.weight,
						maxPoints: c.maxPoints,
						order: i,
					})),
				},
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
		if (this.delegate) {
			return this.delegate.update(id, updates);
		}

		const data: Record<string, unknown> = {};

		if (updates.title) data.title = updates.title;
		if (updates.type) data.type = toPrismaType(updates.type);
		if (updates.category) data.category = toPrismaCategory(updates.category);
		if (updates.difficulty)
			data.difficulty = toPrismaDifficulty(updates.difficulty);
		if (updates.description?.overview)
			data.overview = updates.description.overview;
		if (updates.description?.objectives)
			data.objectives = updates.description.objectives;
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

		const updated = await getPrisma().problem.update({
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
		if (this.delegate) {
			return this.delegate.delete(id);
		}

		await getPrisma().problem.delete({
			where: { id },
		});
	}

	async findById(id: string): Promise<Problem | null> {
		if (this.delegate) {
			return this.delegate.findById(id);
		}

		const problem = await getPrisma().problem.findUnique({
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
		if (this.delegate) {
			return this.delegate.findByExternalId(externalId);
		}

		const problem = await getPrisma().problem.findUnique({
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
		if (this.delegate) {
			return this.delegate.findAll(options);
		}

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

		const problems = await getPrisma().problem.findMany({
			where,
			include: {
				templates: true,
				regions: true,
				criteria: true,
			},
			orderBy: { updatedAt: "desc" },
			skip: options?.offset,
			take: options?.limit,
		});

		return problems.map(toProblem);
	}

	async count(options?: ProblemFilterOptions): Promise<number> {
		if (this.delegate) {
			return this.delegate.count(options);
		}

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

		return getPrisma().problem.count({ where });
	}

	async exists(id: string): Promise<boolean> {
		if (this.delegate) {
			return this.delegate.exists(id);
		}

		const count = await getPrisma().problem.count({
			where: { id },
		});
		return count > 0;
	}
}

export default PrismaProblemRepository;
