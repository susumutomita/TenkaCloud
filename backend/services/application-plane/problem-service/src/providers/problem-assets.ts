import { access, readFile, realpath } from "node:fs/promises";
import * as nodePath from "node:path";

const PROBLEM_REPO_CANDIDATES = [
	process.env.PROBLEMS_DIR,
	nodePath.resolve(process.cwd(), "problems"),
	nodePath.resolve(process.cwd(), "../TenkaCloudChallenge/problems"),
	nodePath.resolve(process.cwd(), "../../../../../TenkaCloudChallenge/problems"),
].filter((candidate): candidate is string => Boolean(candidate));

async function findExistingDirectory(candidates: string[]): Promise<string | null> {
	for (const candidate of candidates) {
		try {
			await access(candidate);
			return await realpath(candidate);
		} catch {
			// Continue searching other candidates.
		}
	}

	return null;
}

export async function getProblemsBaseDir(): Promise<string> {
	const baseDir = await findExistingDirectory(PROBLEM_REPO_CANDIDATES);
	if (!baseDir) {
		throw new Error(
			"Problems directory not found. Set PROBLEMS_DIR or place TenkaCloudChallenge/problems next to the TenkaCloud repo.",
		);
	}

	return baseDir;
}

export async function resolveProblemAssetPath(assetPath: string): Promise<string> {
	if (assetPath.startsWith("http://") || assetPath.startsWith("https://")) {
		return assetPath;
	}

	const baseDir = await getProblemsBaseDir();
	const candidate = nodePath.resolve(baseDir, assetPath);
	const realBase = await realpath(baseDir);
	const realCandidate = await realpath(candidate);

	if (
		realCandidate !== realBase &&
		!realCandidate.startsWith(realBase + nodePath.sep)
	) {
		throw new Error("Invalid problem asset path");
	}

	return realCandidate;
}

export async function loadProblemTextAsset(assetPath: string): Promise<string> {
	if (assetPath.startsWith("http://") || assetPath.startsWith("https://")) {
		const response = await fetch(assetPath);
		if (!response.ok) {
			throw new Error(
				`Failed to fetch problem asset: ${response.status} ${response.statusText} (${assetPath})`,
			);
		}
		return response.text();
	}

	const resolvedPath = await resolveProblemAssetPath(assetPath);
	return readFile(resolvedPath, "utf-8");
}
