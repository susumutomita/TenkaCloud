/**
 * Problem Management Service
 *
 * TenkaCloud の問題管理サービス
 * - 問題定義の管理
 * - イベント（GameDay/JAM）管理
 * - マルチクラウドデプロイ
 * - 採点エンジン
 */

// Types
export * from './types';

// Cloud Providers
export * from './providers';

// Problems
export * from './problems';

// Events
export * from './events';

// Scoring
export * from './scoring';

// Service initialization
import { registerDefaultProviders } from './providers';
import { createScoringEngine } from './scoring';
import { InMemoryProblemRepository, InMemoryMarketplaceRepository } from './problems';
import { InMemoryEventRepository, InMemoryLeaderboardRepository } from './events';
import { ProblemDeployer } from './problems';
import { CloudProviderFactory } from './providers';

/**
 * サービス設定
 */
export interface ServiceConfig {
  /** 最大同時デプロイ数 */
  maxDeployConcurrency?: number;
  /** 最大同時採点数 */
  maxScoringConcurrency?: number;
  /** デプロイタイムアウト（ミリ秒） */
  deployTimeoutMs?: number;
  /** 採点タイムアウト（ミリ秒） */
  scoringTimeoutMs?: number;
}

/**
 * サービスコンテキスト
 */
export interface ServiceContext {
  problemRepository: InMemoryProblemRepository;
  marketplaceRepository: InMemoryMarketplaceRepository;
  eventRepository: InMemoryEventRepository;
  leaderboardRepository: InMemoryLeaderboardRepository;
  problemDeployer: ProblemDeployer;
  scoringEngine: ReturnType<typeof createScoringEngine>;
  providerFactory: CloudProviderFactory;
}

/**
 * サービスの初期化
 */
export function initializeService(config: ServiceConfig = {}): ServiceContext {
  console.log('[ProblemManagement] Initializing service...');

  // プロバイダーの登録
  registerDefaultProviders();
  const providerFactory = CloudProviderFactory.getInstance();

  // リポジトリの作成
  const problemRepository = new InMemoryProblemRepository();
  const marketplaceRepository = new InMemoryMarketplaceRepository(problemRepository);
  const eventRepository = new InMemoryEventRepository();
  const leaderboardRepository = new InMemoryLeaderboardRepository();

  // デプロイヤーの作成
  const problemDeployer = new ProblemDeployer();

  // 採点エンジンの作成
  const scoringEngine = createScoringEngine({
    maxConcurrency: config.maxScoringConcurrency ?? 5,
    timeoutMs: config.scoringTimeoutMs ?? 300000,
  });

  // 採点結果をリーダーボードに反映
  scoringEngine.subscribe(async (result) => {
    try {
      await leaderboardRepository.updateScore(result.eventId, result);
      console.log(`[ProblemManagement] Leaderboard updated for event ${result.eventId}`);
    } catch (error) {
      console.error('[ProblemManagement] Failed to update leaderboard:', error);
    }
  });

  console.log('[ProblemManagement] Service initialized successfully');
  console.log('[ProblemManagement] Registered providers:', providerFactory.getRegisteredProviders());

  return {
    problemRepository,
    marketplaceRepository,
    eventRepository,
    leaderboardRepository,
    problemDeployer,
    scoringEngine,
    providerFactory,
  };
}

/**
 * デフォルトエクスポート
 */
export default {
  initializeService,
};
