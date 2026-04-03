'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

export type Locale = 'ja' | 'en';

interface TranslationMap {
  [key: string]: string | TranslationMap;
}

type TranslationValue = string | TranslationMap;

const messages = {
  ja: {
    nav: {
      dashboard: 'ダッシュボード',
      events: 'イベント',
      rankings: 'ランキング',
      profile: 'プロフィール',
      history: '参加履歴',
      badges: 'バッジ',
      logout: 'ログアウト',
      login: 'ログイン',
      menu: 'メニューを開く',
      user: 'ユーザー',
    },
    common: {
      retry: '再試行',
      loading: '読み込み中',
      save: '保存',
      targetTeam: 'ターゲットチーム',
      selectTeam: 'チームを選択',
      noData: 'データなし',
      language: '言語',
      japanese: '日本語',
      english: 'English',
    },
    dashboard: {
      title: 'ダッシュボード',
      description: '参加中と開催予定のイベントを一覧できます。',
      active: '開催中のイベント',
      scheduled: '登録済みのイベント',
      upcoming: '開催予定のイベント',
      viewAll: 'すべて見る',
      join: 'バトルに参加',
      details: '詳細を見る',
      type: '種別',
      end: '終了',
      start: '開始',
      status: '状況',
      rank: '順位',
      noEvents: 'イベントがありません',
      noEventsDescription:
        '現在参加可能なイベントはありません。新しいイベントが公開されるまでお待ちください。',
      eventsList: 'イベント一覧を見る',
      participants: '参加者',
      problems: '問題数',
      registeredCount: '人登録',
      notJoined: '未参加',
      activeStatus: '開催中',
      scheduledStatus: '予定',
    },
    gameday: {
      title: 'GameDay',
      home: 'Home',
      scoreEvents: 'Score events',
      scoreboard: 'Scoreboard',
      defense: '防衛',
      attack: '攻撃',
      alliance: '同盟',
      voteNav: '投票',
      awsConsole: 'AWS Console',
      menu: 'GameDay メニュー',
      live: 'LIVE',
      stopped: 'STOPPED',
      score: 'Score',
      rank: 'Rank',
      events: 'イベント一覧',
      eventDetail: 'イベント詳細',
      headquarters: '司令部',
      headquartersDescription:
        'チーム状態、ヘルスチェック、最近の攻撃履歴、URL設定を確認します。',
      website: 'Website',
      api: 'API',
      healthy: '正常',
      unhealthy: '異常',
      unchecked: '未チェック',
      healthChecks: 'ヘルスチェック',
      recentAttacks: '最近の攻撃履歴',
      urlSettings: 'URL 設定',
      websiteUrl: 'Website URL',
      apiUrl: 'API URL',
      selectTeam: 'チームを選択してください',
      backToEvent: 'イベントページへ戻る',
      attackStation: '攻撃ステーション',
      attackDescription:
        '攻撃カタログの購入、ターゲット選択、実行結果の確認を行います。',
      targetSelection: 'ターゲット選択',
      attackHistory: '攻撃履歴',
      time: '時間',
      attackName: '攻撃',
      target: '対象',
      result: '結果',
      reward: '報酬',
      success: '成功',
      failed: '失敗',
      noAttackHistory: '攻撃履歴なし',
      defenseTrench: '防衛塹壕',
      defenseDescription:
        '受けている攻撃の状況確認、ヒント購入、修正報告を行います。',
      underAttack: '攻撃を受けている',
      noActiveAttacks: '現在攻撃を受けていません。',
      fixed: '修正済み',
      alliances: '同盟',
      allianceDescription: '同盟の申請、承認、破棄を管理します。',
      allianceRequest: '同盟リクエスト送信',
      activeAlliances: 'アクティブ',
      noAlliances: '同盟なし。',
      incomingRequests: '受信リクエスト',
      outgoingRequests: '送信済みリクエスト',
      send: '送信',
      accept: '承認',
      break: '破棄',
      voting: '投票',
      votingDescription: '他チームへの投票と現在の票数を確認します。',
      votedMessage: '投票済みです。ありがとうございます。',
      voteCount: '票数',
      action: '操作',
      voteAction: '投票する',
      votesReceived: '票獲得',
      noOtherTeams: '他のチームがまだ登録されていません。',
      vulnerability: '脆弱性',
      chaos: 'カオス',
      pending: '保留中',
      activeBadge: 'アクティブ',
      mitigated: '修正済',
      impacted: '影響あり',
      defended: '防御済み',
      hint: 'ヒント',
      reportFix: '修正報告',
      damage: 'ダメージ',
      attacker: '攻撃者',
      cost: 'コスト',
      cooldown: 'クールダウン',
      purchase: '購入',
      execute: '実行',
      received: '受信',
      sent: '送信',
      scoreboardsDescription: 'Security Battle Royale — TenkaCloud GameDay',
      blackout: 'BLACKOUT',
      blackoutDescription:
        'スコアボードは現在ブラックアウト中です。順位は非公開になっています。',
      leaderboard: 'Leaderboard',
      attackStatistics: 'Attack Statistics',
      applicationStatus: 'Application Status',
      attackHistoryAggregate: 'Attack History',
      refreshesEvery30Seconds: '30秒ごとに自動更新',
      teams: 'teams',
    },
  },
  en: {
    nav: {
      dashboard: 'Dashboard',
      events: 'Events',
      rankings: 'Rankings',
      profile: 'Profile',
      history: 'History',
      badges: 'Badges',
      logout: 'Log out',
      login: 'Log in',
      menu: 'Open menu',
      user: 'User',
    },
    common: {
      retry: 'Retry',
      loading: 'Loading',
      save: 'Save',
      targetTeam: 'Target team',
      selectTeam: 'Select a team',
      noData: 'No data',
      language: 'Language',
      japanese: '日本語',
      english: 'English',
    },
    dashboard: {
      title: 'Dashboard',
      description: 'Browse joined events and upcoming competitions.',
      active: 'Active Events',
      scheduled: 'Registered Events',
      upcoming: 'Upcoming Events',
      viewAll: 'View all',
      join: 'Join battle',
      details: 'View details',
      type: 'Type',
      end: 'Ends',
      start: 'Starts',
      status: 'Status',
      rank: 'Rank',
      noEvents: 'No events available',
      noEventsDescription:
        'There are no available events at the moment. Please wait for new events to be published.',
      eventsList: 'Browse events',
      participants: 'Participants',
      problems: 'Problems',
      registeredCount: 'registered',
      notJoined: 'Not joined',
      activeStatus: 'Active',
      scheduledStatus: 'Scheduled',
    },
    gameday: {
      title: 'GameDay',
      home: 'Home',
      scoreEvents: 'Score events',
      scoreboard: 'Scoreboard',
      defense: 'Defense',
      attack: 'Attack',
      alliance: 'Alliance',
      voteNav: 'Vote',
      awsConsole: 'AWS Console',
      menu: 'GameDay menu',
      live: 'LIVE',
      stopped: 'STOPPED',
      score: 'Score',
      rank: 'Rank',
      events: 'Events',
      eventDetail: 'Event details',
      headquarters: 'Headquarters',
      headquartersDescription:
        'Review team status, health checks, recent attacks, and service URLs.',
      website: 'Website',
      api: 'API',
      healthy: 'Healthy',
      unhealthy: 'Unhealthy',
      unchecked: 'Unchecked',
      healthChecks: 'Health checks',
      recentAttacks: 'Recent attacks',
      urlSettings: 'URL settings',
      websiteUrl: 'Website URL',
      apiUrl: 'API URL',
      selectTeam: 'Please select a team.',
      backToEvent: 'Back to event',
      attackStation: 'Attack Station',
      attackDescription:
        'Purchase attack catalog items, choose a target, and review execution history.',
      targetSelection: 'Target Selection',
      attackHistory: 'Attack history',
      time: 'Time',
      attackName: 'Attack',
      target: 'Target',
      result: 'Result',
      reward: 'Reward',
      success: 'Success',
      failed: 'Failed',
      noAttackHistory: 'No attack history',
      defenseTrench: 'Defense Trench',
      defenseDescription:
        'Monitor incoming attacks, purchase hints, and submit fixes.',
      underAttack: 'Active attacks',
      noActiveAttacks: 'No active attacks right now.',
      fixed: 'Mitigated',
      alliances: 'Alliance',
      allianceDescription:
        'Manage alliance requests, approvals, and active partnerships.',
      allianceRequest: 'Send alliance request',
      activeAlliances: 'Active',
      noAlliances: 'No alliances.',
      incomingRequests: 'Incoming requests',
      outgoingRequests: 'Outgoing requests',
      send: 'Send',
      accept: 'Accept',
      break: 'Break',
      voting: 'Voting',
      votingDescription: 'Vote for other teams and review current vote counts.',
      votedMessage: 'Your vote has been submitted. Thank you.',
      voteCount: 'Votes',
      action: 'Action',
      voteAction: 'Vote',
      votesReceived: 'votes',
      noOtherTeams: 'No other teams are registered yet.',
      vulnerability: 'Vulnerability',
      chaos: 'Chaos',
      pending: 'Pending',
      activeBadge: 'Active',
      mitigated: 'Mitigated',
      impacted: 'Impacted',
      defended: 'Defended',
      hint: 'Hint',
      reportFix: 'Report fix',
      damage: 'Damage',
      attacker: 'Attacker',
      cost: 'Cost',
      cooldown: 'Cooldown',
      purchase: 'Purchase',
      execute: 'Execute',
      received: 'Received',
      sent: 'Sent',
      scoreboardsDescription: 'Security Battle Royale — TenkaCloud GameDay',
      blackout: 'BLACKOUT',
      blackoutDescription:
        'The scoreboard is currently under blackout. Rankings are hidden.',
      leaderboard: 'Leaderboard',
      attackStatistics: 'Attack Statistics',
      applicationStatus: 'Application Status',
      attackHistoryAggregate: 'Attack History',
      refreshesEvery30Seconds: 'Refreshes every 30 seconds',
      teams: 'teams',
    },
  },
} as const satisfies Record<Locale, TranslationMap>;

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string) => string;
}

const defaultI18nContext: I18nContextValue = {
  locale: 'en',
  setLocale: () => {},
  t: (key: string) => resolveMessage('en', key),
};

const I18nContext = createContext<I18nContextValue | null>(null);

function resolveMessage(locale: Locale, key: string): string {
  const value = key
    .split('.')
    .reduce<TranslationValue | undefined>(
      (acc, part) =>
        typeof acc === 'object' && acc !== null
          ? (acc[part] as TranslationValue)
          : undefined,
      messages[locale],
    );
  return typeof value === 'string' ? value : key;
}

function detectLocale(searchParams: URLSearchParams | null): Locale {
  const fromQuery = searchParams?.get('lang');
  if (fromQuery === 'ja' || fromQuery === 'en') return fromQuery;

  if (typeof window !== 'undefined') {
    const stored = window.localStorage.getItem('tenkacloud_locale');
    if (stored === 'ja' || stored === 'en') return stored;

    if (window.navigator.language.toLowerCase().startsWith('ja')) return 'ja';
  }

  return 'en';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const [locale, setLocaleState] = useState<Locale>(() => detectLocale(null));

  useEffect(() => {
    setLocaleState(detectLocale(searchParams));
  }, [searchParams]);

  useEffect(() => {
    document.documentElement.lang = locale;
    window.localStorage.setItem('tenkacloud_locale', locale);
  }, [locale]);

  const setLocale = (nextLocale: Locale) => {
    setLocaleState(nextLocale);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('tenkacloud_locale', nextLocale);
    }

    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('lang', nextLocale);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  };

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key: string) => resolveMessage(locale, key),
    }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  return context ?? defaultI18nContext;
}
