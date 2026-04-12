/**
 * Prisma Marketplace Repository 実装
 */

import type {
	Problem as PrismaProblem,
	MarketplaceListing,
} from "@prisma/client";
import { prisma as _prisma } from "./prisma-client";
import type { IMarketplaceRepository } from "../problems/repository";
import type {
	MarketplaceProblem,
	MarketplaceSearchQuery,
	MarketplaceSearchResult,
} from "../types";
import {
	toProblem,
	toPrismaType,
	toPrismaCategory,
	toPrismaDifficulty,
	toPrismaCloudProvider,
} from "./problem-mapper";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getPrisma(): any {
	if (!_prisma) {
		throw new Error(
			'Prisma client is not available. Run "bunx prisma generate" or use DynamoDB-based repositories.',
		);
	}
	return _prisma;
}

export class PrismaMarketplaceRepository implements IMarketplaceRepository {
	async publish(problemId: string): Promise<MarketplaceProblem> {
		const problem = await getPrisma().problem.findUnique({
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

		const listing = await getPrisma().marketplaceListing.upsert({
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
		await getPrisma().marketplaceListing.delete({
			where: { id: marketplaceId },
		});
	}

	async search(
		query: MarketplaceSearchQuery,
	): Promise<MarketplaceSearchResult> {
		const where: Record<string, unknown> = {};

		if (query.query) {
			where.problem = {
				OR: [
					{ title: { contains: query.query, mode: "insensitive" } },
					{ overview: { contains: query.query, mode: "insensitive" } },
					{ tags: { hasSome: [query.query.toLowerCase()] } },
				],
			};
		}
		if (query.type) {
			where.problem = {
				...(where.problem as object),
				type: toPrismaType(query.type),
			};
		}
		if (query.category) {
			where.problem = {
				...(where.problem as object),
				category: toPrismaCategory(query.category),
			};
		}
		if (query.difficulty) {
			where.problem = {
				...(where.problem as object),
				difficulty: toPrismaDifficulty(query.difficulty),
			};
		}
		if (query.provider) {
			where.problem = {
				...(where.problem as object),
				providers: { has: toPrismaCloudProvider(query.provider) },
			};
		}

		let orderBy: Record<string, "asc" | "desc"> = { downloadCount: "desc" };
		switch (query.sortBy) {
			case "rating":
				orderBy = { averageRating: "desc" };
				break;
			case "downloads":
				orderBy = { downloadCount: "desc" };
				break;
			case "newest":
				orderBy = { publishedAt: "desc" };
				break;
		}

		const page = query.page || 1;
		const limit = query.limit || 20;
		const skip = (page - 1) * limit;

		const p = getPrisma();
		const [listings, total] = await Promise.all([
			p.marketplaceListing.findMany({
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
			p.marketplaceListing.count({ where }),
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
		const listing = await getPrisma().marketplaceListing.findUnique({
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
		await getPrisma().marketplaceListing.update({
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
		},
	): Promise<void> {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await getPrisma().$transaction(async (tx: any) => {
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
				reviews.reduce(
					(sum: number, r: { rating: number }) => sum + r.rating,
					0,
				) / reviews.length;

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
				templates?: {
					provider: string;
					type: string;
					path: string;
					parameters: unknown;
				}[];
				regions?: { provider: string; regions: string[] }[];
				criteria?: {
					name: string;
					description: string | null;
					weight: number;
					maxPoints: number;
				}[];
			};
			reviews?: { rating: number }[];
		},
	): MarketplaceProblem {
		const problem = toProblem(listing.problem);
		return {
			...problem,
			marketplaceId: listing.id,
			status: "published",
			publishedAt: listing.publishedAt,
			downloadCount: listing.downloadCount,
			rating: listing.averageRating,
			reviews:
				listing.reviews?.map((r) => ({
					id: "review",
					userId: "",
					userName: "",
					rating: r.rating,
					comment: "",
					createdAt: new Date(),
				})) || [],
		};
	}
}
