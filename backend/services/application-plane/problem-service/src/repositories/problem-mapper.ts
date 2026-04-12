/**
 * Prisma ↔ Domain 型変換ユーティリティ
 */

import type {
	Problem as PrismaProblem,
	ProblemType as PrismaProblemType,
	ProblemCategory as PrismaProblemCategory,
	DifficultyLevel as PrismaDifficultyLevel,
	CloudProvider as PrismaCloudProvider,
	TemplateType as PrismaTemplateType,
} from "@prisma/client";
import type {
	Problem,
	ProblemType,
	ProblemCategory,
	DifficultyLevel,
	CloudProvider,
	DeploymentTemplate,
	DeploymentTemplateType,
} from "../types";

/**
 * Prisma Problem を内部型に変換
 */
export function toProblem(
	prismaProblem: PrismaProblem & {
		templates?: {
			provider: string;
			type: string;
			path: string | null;
			content: string | null;
			parameters: unknown;
		}[];
		regions?: { provider: string; regions: string[] }[];
		criteria?: {
			name: string;
			description: string | null;
			weight: number;
			maxPoints: number;
		}[];
	},
): Problem {
	const templatesMap: Partial<Record<CloudProvider, DeploymentTemplate>> = {};
	prismaProblem.templates?.forEach((t) => {
		const provider = t.provider.toLowerCase() as CloudProvider;
		templatesMap[provider] = {
			type: t.type as DeploymentTemplateType,
			path: t.path ?? undefined,
			content: t.content ?? undefined,
			parameters: t.parameters as Record<string, string> | undefined,
		};
	});

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
				(p) => p.toLowerCase() as CloudProvider,
			),
			timeout: prismaProblem.deploymentTimeoutMinutes,
			templates: templatesMap,
			regions: regionsMap,
		},
		scoring: {
			type: prismaProblem.scoringType.toLowerCase() as
				| "lambda"
				| "container"
				| "api"
				| "manual",
			path: prismaProblem.scoringPath,
			timeoutMinutes: prismaProblem.scoringTimeoutMinutes,
			intervalMinutes: prismaProblem.scoringIntervalMinutes ?? undefined,
			criteria:
				prismaProblem.criteria?.map((c) => ({
					name: c.name,
					description: c.description ?? "",
					weight: c.weight,
					maxPoints: c.maxPoints,
				})) || [],
		},
	};
}

export function toPrismaType(type: ProblemType): PrismaProblemType {
	const map: Record<ProblemType, PrismaProblemType> = {
		gameday: "GAMEDAY",
		jam: "JAM",
	};
	return map[type];
}

export function toPrismaCategory(
	category: ProblemCategory,
): PrismaProblemCategory {
	const map: Record<ProblemCategory, PrismaProblemCategory> = {
		architecture: "ARCHITECTURE",
		security: "SECURITY",
		cost: "COST",
		performance: "PERFORMANCE",
		reliability: "RELIABILITY",
		operations: "OPERATIONS",
	};
	return map[category];
}

export function toPrismaDifficulty(
	difficulty: DifficultyLevel,
): PrismaDifficultyLevel {
	const map: Record<DifficultyLevel, PrismaDifficultyLevel> = {
		easy: "EASY",
		medium: "MEDIUM",
		hard: "HARD",
		expert: "EXPERT",
	};
	return map[difficulty];
}

export function toPrismaCloudProvider(
	provider: CloudProvider,
): PrismaCloudProvider {
	const map: Record<CloudProvider, PrismaCloudProvider> = {
		aws: "AWS",
		gcp: "GCP",
		azure: "AZURE",
		local: "LOCAL",
	};
	return map[provider];
}

export function toPrismaTemplateType(
	type: DeploymentTemplateType | undefined,
): PrismaTemplateType {
	const map: Record<DeploymentTemplateType, PrismaTemplateType> = {
		cloudformation: "CLOUDFORMATION",
		sam: "SAM",
		cdk: "CDK",
		terraform: "TERRAFORM",
		"deployment-manager": "DEPLOYMENT_MANAGER",
		arm: "ARM",
		"docker-compose": "DOCKER_COMPOSE",
	};
	return map[type ?? "cloudformation"] ?? "CLOUDFORMATION";
}
