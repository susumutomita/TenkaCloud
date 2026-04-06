import { z } from "zod";

/**
 * ホスト名がプライベート/リンクローカルIPかどうかを判定する
 *
 * ブロック対象:
 * - localhost
 * - プライベート IPv4: 127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x, 0.0.0.0
 * - IPv6 ループバック: ::1
 * - IPv6 マップドアドレス: ::ffff:x.x.x.x, ::ffff:xxxx:xxxx
 * - 数値 IP エンコード: 10進、16進（0x）、8進（0）、混合形式
 * - 非 http/https スキーム
 *
 * @param hostname - URL.hostname から取得したホスト名
 * @returns ブロック対象の場合 true
 */
export function isBlockedHost(hostname: string): boolean {
	const h = hostname.toLowerCase();
	if (h === "localhost") return true;
	// IPv6 ブラケット除去
	const bare = h.startsWith("[") ? h.slice(1, -1) : h;
	// IPv6 ループバック
	if (bare === "::1") return true;
	// IPv6 マップドアドレス（テキスト形式・16進形式の両方）
	if (bare.startsWith("::ffff:")) return true;
	// 数値のみ/16進/8進のホスト名（10進IP、0x16進IP、先頭0の8進IP）
	if (/^[\d.ox]+$/i.test(bare) && /^[\d.]+$/.test(bare) === false) return true;
	// 純粋な10進数値IP（例: 2130706433）
	if (/^\d+$/.test(bare)) return true;
	// 各オクテットに8進数(0始まり)や16進数(0x始まり)が含まれるIPをブロック
	// 例: 0177.0.0.1, 0x7f.0.0.1
	const octets = bare.split(".");
	if (
		octets.length === 4 &&
		octets.some((o) => /^0[xo0-7]/i.test(o) && o !== "0")
	) {
		return true;
	}
	// プライベート IPv4 レンジ
	const PRIVATE_RANGES =
		/^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0)/;
	return PRIVATE_RANGES.test(bare);
}

const safeUrl = z
	.string()
	.url()
	.refine(
		(url) => {
			try {
				const parsed = new URL(url);
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
					return false;
				}
				return !isBlockedHost(parsed.hostname);
			} catch {
				return false;
			}
		},
		{ message: "プライベートネットワークへのURLは許可されていません" },
	);

// 共通: eventId のみのリクエスト
export const eventIdSchema = z.object({
	eventId: z.string().min(1),
});

// 管理者: ゲーム開始
export const startGameSchema = z.object({
	eventId: z.string().min(1),
	durationMinutes: z.number().int().min(1).max(480).default(240),
});

// 管理者: ゲーム初期化（isRunning: false で作成。tenantId は認証コンテキストから取得）
export const initGameSchema = z.object({
	eventId: z.string().min(1),
	durationMinutes: z.number().int().min(1).max(480).default(240),
});

// 管理者: 障害注入
export const faultInjectionSchema = z.object({
	eventId: z.string().min(1),
	teamId: z.string().min(1),
	attackSlug: z.string().min(1),
});

// 管理者: 攻撃カタログシード
export const seedAttacksSchema = z.object({
	eventId: z.string().min(1),
});

// 管理者: チーム登録
export const registerTeamSchema = z.object({
	eventId: z.string().min(1),
	teamId: z.string().min(1),
	teamName: z.string().min(1),
	websiteUrl: safeUrl.optional(),
	apiUrl: safeUrl.optional(),
});

// プレーヤー: チーム URL 更新
export const updateTeamUrlSchema = z.object({
	eventId: z.string().min(1),
	teamId: z.string().min(1),
	websiteUrl: safeUrl.optional(),
	apiUrl: safeUrl.optional(),
});

// プレーヤー: 攻撃購入
export const purchaseAttackSchema = z.object({
	eventId: z.string().min(1),
	teamId: z.string().min(1),
	attackId: z.string().min(1),
});

// プレーヤー: 攻撃実行
export const executeAttackSchema = z.object({
	eventId: z.string().min(1),
	teamId: z.string().min(1),
	attackId: z.string().min(1),
	targetTeamId: z.string().min(1),
});

// プレーヤー: ヒント購入
export const purchaseHintSchema = z.object({
	eventId: z.string().min(1),
	teamId: z.string().min(1),
	attackId: z.string().min(1),
});

// プレーヤー: 脆弱性修正報告
export const reportFixSchema = z.object({
	eventId: z.string().min(1),
	teamId: z.string().min(1),
	vulnerabilitySlug: z.string().min(1),
});

// プレーヤー: 同盟申請
export const requestAllianceSchema = z.object({
	eventId: z.string().min(1),
	teamId: z.string().min(1),
	targetTeamId: z.string().min(1),
});

// プレーヤー: 同盟承認/破棄
export const allianceActionSchema = z.object({
	eventId: z.string().min(1),
	teamId: z.string().min(1),
});

// プレーヤー: 投票
export const voteSchema = z.object({
	eventId: z.string().min(1),
	teamId: z.string().min(1),
	votedForTeamId: z.string().min(1),
});
