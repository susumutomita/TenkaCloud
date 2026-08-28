/**
 * Participant portal API の wire contract (Issue #2203)。
 *
 * ここが唯一の定義箇所: backend (`infrastructure/lib/problem-deploy/handlers/participant-handler/`)
 * と SPA (`apps/participant-portal/src/api/portal-client/`) の両方が本パッケージを import する。
 * 旧構成は両側に手写しミラー型があり、 field 追加が片側に伝わらない無音ドリフト (#2198) が
 * 構造的に起きていた。 以後、 shape の変更は本ファイルに 1 回加えれば両側の typecheck が検出する。
 *
 * optionality の規約: 「SPA が受信しうる JSON の和集合」 を表す。
 *   - AWS mode (participant-handler) と local mode (local-play API) で送る field が異なるもの
 *     (name / description / instructions / i18n 等) は optional
 *   - 旧 backend 応答との rolling 互換を要するもの (provider 等) も optional
 *   - backend 側で「必ず埋める」ことを型で強制したい field は、 backend 側が本契約型との
 *     intersection で optionality を tighten する (定義の重複にはならない)
 *
 * 回答秘匿のため、flagOutputKey の値・per-endpoint URL / 名前は
 * 本契約のどの型にも現れない。 field を足すときは「競技者に見せてよいか」 を必ず確認する。
 */

// Issue #2696 / #2707: LP デモポータルのオンボーディングドリル (意図的公開のチェック
// ポイントコード。 上の回答秘匿の不変条件の例外ではなく、 競技 flag ではない教材用契約)。
export * from "./lite-drill.js";
export * from "./local-drill.js";

// #2925 / #2926: 問題カタログの fairness projection。 participant-portal の build-time glob と
// local-play control plane の runtime catalog endpoint が同じ投影を通るよう、 ここが唯一の定義。
export * from "./problem-catalog.js";
export * from "./problem-course-projection.js";

export type DeploymentStatus =
  | "PENDING"
  // Issue #2019: held by TrustBridge enforcement pending operator
  // approval (no stack created yet). In-flight, not terminal — treated like
  // PENDING in the portal.
  | "APPROVAL_PENDING"
  | "IN_PROGRESS"
  | "COMPLETE"
  | "FAILED"
  | "DELETING"
  | "DELETED"
  | "EXPIRED"
  | "AUTO_DELETED";

export const TERMINAL_STATUSES: ReadonlySet<DeploymentStatus> = new Set([
  "COMPLETE",
  "FAILED",
  "DELETED",
  "EXPIRED",
  "AUTO_DELETED",
]);

/**
 * problem metadata で定義された builtin scoring kind。
 * Phase 1 (旧 view) は flag / uptime のみだったが、 Phase 3 で phased-polling /
 * uptime-flat / uptime-multi / attack-detection が追加された。
 * UI 表示 (= categoryOf) は Battle / Challenge の 2 軸に collapse する。
 */
export type ScoringKind =
  | "flag"
  | "multi-flag"
  | "uptime"
  | "uptime-flat"
  | "uptime-multi"
  | "phased-polling"
  | "attack-detection";

/**
 * ヒントの公開順 (問題の `scoring.hintReveal`)。 `problem-sdk` の `HintRevealMode` の
 * 参加者向けミラー (= portal-contracts は problem-sdk に依存しない契約境界なので、
 * `ScoringKind` と同様にここで独立宣言する)。
 *   - `"flat"`     — 全 hint を任意順で公開可 (portal は順序ゲートを外す)
 *   - `"sequential"` / 未指定 — hint 1→2→3 の順 (既定。 progressive gate 維持)
 */
export type HintRevealMode = "sequential" | "flat";

/**
 * Issue #1796: multi-flag の 1 sub-flag の view。 正解値 (flagOutputKey の値) は含めない
 * (= 答えを漏らさない)。 `solved` は team の解済 flag id 集合に含まれるかで判定済み。
 */
export interface MultiFlagEntryView {
  readonly id: string;
  readonly label: string;
  /** #2876: multiline preserves source-code newlines; absent / text stays one-line. */
  readonly input?: "text" | "multiline";
  readonly points: number;
  readonly solved: boolean;
  /**
   * [#2252] multi-verify (local-play) の per-check hints。 AWS multi-flag は現状
   * 送らない (= optional、 既存問題に影響なし)。 shape は問題レベルの hints と同一で、
   * reveal も既存 flat route (`/problems/:id/hints/:hintId/reveal`) を使う。
   */
  readonly hints?: readonly ParticipantHintView[];
  /** [#2252] `i18n.en.checks[]` 由来の label 訳。 配点・ID は翻訳側に重複させない。 */
  readonly i18n?: { readonly en?: { readonly label?: string } };
}

/**
 * Issue #742 Phase 4: progressive hint view shape。 revealed=false な hint は content 不在
 * (= server-side で content を落として送り、 答えを frontend に漏らさない)。
 * revealed=true は content + revealedAt を含む。
 */
export interface ParticipantHintView {
  readonly id: string;
  readonly penalty: number;
  readonly revealed: boolean;
  readonly content?: string;
  readonly revealedAt?: string;
  /**
   * #2054 i18n: locale override of `content` (en only; ja is the canonical
   * `content`). Present only once the hint is revealed, mirroring `content`.
   */
  readonly i18n?: { readonly en?: { readonly content?: string } };
}

/**
 * Participant 側に出してよい scoring 情報の view。 kind ごとに見える field は最小限
 * (= 答えとなる flagOutputKey の値 / 攻撃 counter の生値 / 内部 platformRules の細部は出さない)。
 */
export interface ParticipantScoringInfo {
  readonly kind: ScoringKind;
  readonly points?: number;
  readonly pointsPerSuccess?: number;
  /** uptime-flat: 全 endpoint healthy のときの加点。 (#2198 で SPA ミラーから欠落していた field) */
  readonly pointsAllOk?: number;
  /** attack-detection: 検知 1 回あたりの加点。 (#2198 で SPA ミラーから欠落していた field) */
  readonly pointsPerAttack?: number;
  readonly hints?: readonly ParticipantHintView[];
  /** Challenge / flag のとき、 提出済みなら true。 再提出は加点されない。 */
  readonly flagSubmitted?: boolean;
  /** Issue #1796: multi-flag の sub-flag 一覧 (= N 個の提出欄を出すための view)。 */
  readonly flags?: readonly MultiFlagEntryView[];
  /**
   * 問題が指定する hint 公開順 (`scoring.hintReveal`)。 問題レベルの hints にも
   * 各 sub-flag の hints にも同じモードが適用される。
   *   - `"flat"`     — 全 hint を任意順で公開可 (portal は順序ゲートを外す)
   *   - `"sequential"` / 未指定 — hint 1→2→3 の順 (既定。 progressive gate 維持)
   * 答えではないので participant に出してよい (= どの順で開けられるかの UI 情報のみ)。
   */
  readonly hintReveal?: HintRevealMode;
}

/**
 * Battle (uptime kind) の集約 health。per-endpoint URL / 名前は **絶対に
 * 露出しない** (= 「なぜ壊れているか」 を防御側自身が調査するゲーム性のため)。
 * Challenge (flag kind) では undefined。
 */
export type ApplicationStatusOverall = "healthy" | "degraded" | "down" | "unknown";

export interface ApplicationStatus {
  readonly overall: ApplicationStatusOverall;
  readonly healthyCount: number;
  readonly totalCount: number;
  /** 最後の probe 時刻 (ISO 8601)。 `unknown` のときは undefined。 */
  readonly checkedAt?: string;
}

/**
 * Issue #2422: 1 attack-probe の直近サイクルの結果。
 *   - `"landed"`  — 攻撃 probe が刺さり、 このサイクルで penalty が減点された (= 脆弱)
 *   - `"blocked"` — probe は撃たれたが防御が持ちこたえ、 減点なし (= 防御成功)
 *   - `"skipped"` — slot 未解決 / 到達不能で判定不能 (= 減点なし。 可用性は別途 applicationStatus)
 *
 * 非スポイラー不変条件: probe の `slot` / `path` (= 正確な
 * endpoint) や脆弱性クラスは **絶対に含めない**。 出せるのは問題側 metadata が明示的に開示した
 * `label` / `symptom` (author が書いた非スポイラー文言) と、 減点量 (`penalty`) のみ。
 */
export type AttackProbeOutcome = "landed" | "blocked" | "skipped";

export interface AttackProbeResult {
  /** 問題 metadata が開示した非スポイラーな probe 名 (未設定なら UI が index で採番)。 */
  readonly label?: string;
  /** 問題 metadata が開示した非スポイラーな症状文言 (脆弱性クラス・endpoint は含めない)。 */
  readonly symptom?: string;
  readonly outcome: AttackProbeOutcome;
  /** この probe が landed のときに減点される points (> 0)。 delta = landed ? -penalty : 0。 */
  readonly penalty: number;
}

/**
 * Issue #2422: uptime-multi Battle の直近サイクルの attack-probe 集約。 defender が
 * 「green (200) なのに満点にならない理由」 (= まだ刺さっている probe) を可視化する。
 * attackProbes 未設定の問題 / 旧 deployment 行では undefined。
 */
export interface AttackProbeStatus {
  /** 最後に attack-probe を撃った時刻 (ISO 8601)。 */
  readonly checkedAt?: string;
  readonly probes: readonly AttackProbeResult[];
}

export interface DeploymentLogEntry {
  readonly id: string;
  readonly timestamp: string;
  /**
   * `/portal/me` 同梱 log は "deployment" のみ。 "codebuild" は deploy-logs route が (CodeBuild
   * 経路の deploy build から) 送る。 "lambda" は同 route が Lambda 経路の deploy (#2291) で jobId
   * 名の CloudWatch stream から送る (= deployViaLambda ON。 CodeBuild build が無いケース)。
   */
  readonly source: "deployment" | "codebuild" | "lambda";
  readonly level: "info" | "success" | "warning" | "error";
  readonly message: string;
}

export interface DeploymentLogView {
  /**
   * `/portal/me` polling で差分判定するための cursor。 現状は DDB row の updatedAt を使い、
   * CloudWatch Logs 直読を後続で足す場合は nextToken に差し替え可能な shape にしておく。
   */
  readonly cursor: string;
  readonly entries: readonly DeploymentLogEntry[];
}

/**
 * #2054 i18n: competitor-facing problem text translated into a non-default
 * locale (en). The default language (ja) lives in the top-level fields.
 */
export interface ProblemTextI18n {
  readonly name?: string;
  readonly description?: string;
  readonly instructions?: string;
  /** Issue #2191: translated post-solve explanation; absent until release policy allows it. */
  readonly writeup?: string;
  /** Optional locale-specific operation video when the canonical video is not bilingual. */
  readonly videoUrl?: string;
}

/**
 * Issue #2235: 問題への参加者アクセス capability。割り当ての正本は backend の
 * composite-target-access.ts (aws → console + cli-credentials、 gcp / azure / sakura →
 * external-portal、 未知 provider → unsupported)。 credential / URL は含まない。
 */
export type TargetAccessCapability =
  | "console"
  | "cli-credentials"
  | "external-portal"
  | "unsupported";

/** Local-play runtime family; absent on legacy/AWS participant views. */
export type ProblemRuntimeKind = "docker" | "simulated-cloud";

/**
 * Phase 2c: 1 problem 単位の view (= team の N 問題のうち 1 つ)。
 */
export interface ParticipantProblemView {
  readonly jobId: string;
  readonly problemId: string;
  /**
   * #1975: 問題文 (metadata.json 由来)。 local mode の Participant API は同梱して返すので、
   * portal は「何の問題か / 何をすべきか」 を表示できる。 AWS mode の participant-handler は
   * まだ返さない (= 別 follow-up) ため optional。 不在時は problemId を title に fall back する。
   */
  readonly name?: string;
  readonly description?: string;
  readonly instructions?: string;
  /**
   * Issue #2191: learning explanation. The backend omits it during cloud competition
   * and for unsolved problems; local drill mode includes it only after completion.
   */
  readonly writeup?: string;
  /**
   * #2054 i18n: locale override of name/description/instructions (en only; ja is
   * the canonical top-level value). The portal's locale switcher resolves the
   * displayed text via `localizeProblem`. Absent when no translation is shipped.
   */
  readonly i18n?: { readonly en?: ProblemTextI18n };
  /**
   * #2707 P0-1: optional 1-minute operation video shown above the problem body.
   * Must be a same-origin URL (the landing CSP forbids external embeds), served
   * from the hosting origin (e.g. `/videos/onboarding/<problemId>.mp4`). A video
   * that is not bilingual may provide a locale-specific URL through `i18n.en.videoUrl`.
   * Absent — or unloadable in the current environment — the problem renders
   * unchanged: the video is an enhancement, never a prerequisite.
   */
  readonly videoUrl?: string;
  /**
   * [#2392 Phase 2] local-play on-demand container status. The warm local
   * session serves the whole catalog, so a problem is `stopped` until started.
   * AWS mode never sends it (no per-competitor container lifecycle); absent is
   * treated as `running` (backward compat with the pre-Phase-2 wire).
   */
  readonly lifecycle?: {
    readonly status: "stopped" | "starting" | "running" | "error";
    /** Enables runtime-specific controls without exposing runtime credentials or URLs. */
    readonly runtimeKind?: ProblemRuntimeKind;
    /**
     * [#2850] Local-play only: present when this problem's metadata explicitly opts
     * into the container terminal (`runtime.terminal`). The terminal is an
     * authorization surface — a shell reads whatever the target image holds — so the
     * portal renders the terminal panel only on this flag, never on `runtimeKind`
     * alone. AWS mode never sends it.
     */
    readonly terminal?: true;
    /** A failed operation still owns local resources; Stop retries cleanup before restart. */
    readonly cleanupRequired?: true;
    /**
     * Why the last async start / stop failed (status "error" のときのみ)。 container
     * start は 202 で先に返り (= 初回の compose イメージビルドが数分かかっても
     * Codespaces の forwarded proxy に切られない)、 失敗理由は polling で読むこの
     * field が唯一の伝達経路になる。 表示専用の human-readable text。
     */
    readonly lastError?: string;
  };
  /**
   * [#2696 PR5] Local-play only: true when this is the platform's one fixed
   * intro drill (`challenges/hello-world`, selected by `recommended: true`).
   * `scripts/local-play/catalog-loader.ts` pins this problem first in the
   * catalog; the portal renders a "start here" badge on it. AWS mode never
   * sends this field.
   */
  readonly recommended?: true;
  readonly region: string;
  /** 競技アカウント ID。 SSO Credentials の AWS Console federation で使う。
   *  (機密ではない — IAM role 信頼ポリシーや CFn template にも露出する。) */
  readonly awsAccountId: string;
  /**
   * [#2233] 問題が動く cloud provider。 canonical 値は "aws" | "sakura" | "azure" | "gcp"。
   * 現行 backend (participant-handler lookup) は常に返すが、 旧 backend 応答との互換のため
   * wire contract 上は optional (不在 = aws。 = 行契約と同じ legacy 既定、 `problemProvider()`
   * で解決する)。 未知値は raw 表示 fallback (`providerLabel()`)。
   */
  readonly provider?: string;
  /**
   * [#2235 / #2260] この問題への参加者アクセス capability (provider の純関数)。 portal は
   * これで導線 (AWS Console/CLI vs external-portal 案内) を分岐する。 現行 backend は常に
   * 返すが、 旧 backend 応答との互換のため optional。
   */
  readonly accessCapabilities?: readonly TargetAccessCapability[];
  readonly status: DeploymentStatus;
  readonly stackOutputs: Record<string, string>;
  readonly failureReason?: string;
  readonly expiresAt: number;
  readonly score: number;
  readonly lastScoredAt?: string;
  readonly lastResult?: "ok" | "fail";
  readonly posture?: Record<string, boolean>;
  readonly platform?: string;
  readonly scoring?: ParticipantScoringInfo;
  readonly deployLog: DeploymentLogView;
  /** Issue #607: deploy 開始時刻 (DDB.createdAt の echo)。 portal の phase countdown が
   *  metadata.phases / disruptions の afterMinutes との差で残時間を計算する。 deploy 中の
   *  PENDING / IN_PROGRESS でも present。 */
  readonly createdAt?: string;
  /** Battle (uptime) のみ aggregate health を露出。 */
  readonly applicationStatus?: ApplicationStatus;
  /**
   * Issue #2422: uptime-multi Battle の直近サイクルの attack-probe 結果 (= 「green なのに
   * 満点でない理由」)。 attackProbes を持つ問題でのみ present、 それ以外は undefined。
   * per-endpoint URL / 脆弱性クラスは含めず、 問題側が開示した label / symptom のみ。
   */
  readonly attackProbeStatus?: AttackProbeStatus;
}

/**
 * Issue #1038 P0 #2: 競技開始前 / 終了 / 一時停止 の gate 状態を backend が計算して返す
 * (= participant-handler `/portal/me`)。
 *
 * frontend は `kind: "scoring_not_started"` のとき ProblemDetail page を lock screen
 * (= 「競技開始前です」 表示) に切り替える。 backend 側で fail-closed を担保するので
 * eventId 不在 / gate 取得失敗時も "scoring_not_started" が返り、 不正アクセスを防ぐ。
 */
export type ParticipantEventGate =
  | { readonly kind: "ok" }
  | { readonly kind: "scoring_not_started"; readonly startsAt?: string }
  | { readonly kind: "scoring_ended"; readonly endsAt?: string }
  | { readonly kind: "scoring_locked" };

/**
 * Issue #2283: Progression Gate (問題アンロック / チーム別ハンデ) の team 視点 view。
 * Event に Gate 設定があり、 かつ per-tenant feature flag `challengePrerequisiteGate`
 * (既定 OFF) が ON のときだけ backend が `/portal/me` に含める。 それ以外は field ごと
 * 不在 (= 従来 shape、 全問題を従来どおり開始可能)。
 *
 * lock 状態は backend が毎 read 導出する。 frontend は
 *   - `lockedProblemIds` に含まれる問題を locked 表示する (存在は隠さない)
 *   - `gateProblemId` を 「最初にここから」 と案内する
 *   - `gateCompleted` になったら (polling / 再取得で) unlock 表示へ遷移する
 * だけで、 実際の拒否は backend の access guard が行う (= UI 改ざんで bypass 不可)。
 */
export type ProgressionGatePolicy = "required" | "off";

export interface ParticipantProgressionView {
  /** 前提 (Gate) challenge の problemId。 */
  readonly gateProblemId: string;
  /** この team が Gate を完了済みか (= 初回加点 / flag 正解)。 */
  readonly gateCompleted: boolean;
  /** この team に効いている policy (Event default + team override 合成後)。 */
  readonly policy: ProgressionGatePolicy;
  /** Gate 完了時に 1 度だけ付与される bonus (無指定 team は 0)。 */
  readonly completionBonus: number;
  /** 現時点で locked な problemId 一覧 (policy=off / 完了後は空)。 */
  readonly lockedProblemIds: readonly string[];
}

/**
 * Phase 2c: team の集約 view。 1 teamLoginKey で event 内の N 問題を引ける。
 *
 * 設計判断: per-endpoint health (どの endpoint が落ちているか) は participant API には
 * 出さない。 Battle のゲーム性 = 「なぜ壊れているかを防御側自身が調査して回復する」。
 */
export interface ParticipantTeamView {
  readonly team: {
    readonly teamName: string;
    readonly teamNameSetByCompetitor: boolean;
    /** Phase 1 以前に作られた deployment は持たない。 */
    readonly eventId?: string;
    readonly teamId?: string;
  };
  readonly problems: readonly ParticipantProblemView[];
  /** Issue #1038 P0 #2: event gate (= 競技開始前 / 終了 / lock 中) status。 */
  readonly eventGate?: ParticipantEventGate;
  /**
   * Issue #2283: Progression Gate の team 視点 view。 Gate 設定なし / feature flag OFF
   * (既定) では不在 (= 既存挙動)。 locked 問題は `stackOutputs` が空で返る点に注意
   * (unlock 後の再取得で埋まる)。
   */
  readonly progression?: ParticipantProgressionView;
}

/**
 * flag 提出の wire 応答 (= HTTP 200 で返る JSON body の union)。
 * backend 内部の outcome (unauthorized / no_outputs 等の非 200 系) は本契約には含めない —
 * それらは HTTP status へ map され、 body 契約はエラー応答契約 (`invalid_body` 等) に従う。
 */
export type SubmitFlagOutcome =
  /** Issue #1796: multi-flag のとき、 どの sub-flag が解けたかを示す `flagId` を含む。 */
  | { kind: "ok"; scoreDelta: number; totalScore: number; flagId?: string }
  | { kind: "already_scored"; totalScore: number }
  /**
   * Issue #817: 不正解。 問題 metadata に `wrongAnswerPenalty` が設定されていれば
   * `scoreDelta` は負数 (= 減点)。 設定されていなければ 0。 wrongCount は累計試行回数。
   * `message` は問題 container の /verify が返した property-level の失敗理由
   * (VerifyResponseSchema が 2000 文字で cap)。 理由を返さない judge では欠ける。
   */
  | {
      kind: "wrong";
      scoreDelta: number;
      totalScore: number;
      wrongCount: number;
      message?: string;
    };

/**
 * Phase 3: Event scope の team ランキング (= Scoreboard) の 1 行 (1 team の集計)。
 *
 * 競技者向けに公開しても安全な情報のみ。 teamLoginKey / tenantId / awsAccountId 等の
 * 運営情報は **絶対に出さない**。 teamId は同 event 内の同定に使うが、 推測困難な ULID
 * なので公開で問題ない。
 */
export interface LeaderboardEntry {
  readonly rank: number;
  readonly teamId: string;
  readonly teamName: string;
  readonly score: number;
  readonly completedProblems: number;
  readonly totalProblems: number;
  /** requester 自身のチームなら true (UI ハイライト用)。 */
  readonly isMyTeam: boolean;
}

export interface LeaderboardResponse {
  readonly eventId: string;
  readonly entries: readonly LeaderboardEntry[];
  /**
   * Issue #1038 P1 #9: scoreboard freeze (= 終了 30 分前から最終結果まで順位非公開)。
   * true なら frontend は entries を隠して「凍結中」 メッセージを表示する (= 終盤の
   * 駆け込み防止 + 競技公平性)。
   */
  readonly scoreboardFrozen?: boolean;
  /** event の終了予定時刻 (ISO 8601、 UI で「あと N 分で公開」 表示用)。 */
  readonly endsAt?: string;
}
