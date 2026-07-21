/**
 * #2707 P1 / #2711: オンボーディングドリル 3 本の 1 分 operation 動画の台本 (source of truth)。
 *
 * この module が「再撮影用の台本」そのもの。 スライド文言を直して
 * `bun run scripts/landing/onboarding-videos/render.ts` を実行すると
 * `landing/videos/onboarding/<problemId>.mp4` が再生成される (要 chromium + ffmpeg、
 * 手順は render.ts のヘッダーコメント参照)。
 *
 * 設計制約:
 * - 音声なし・字幕 (スライド文字) だけで理解できること (#2696 の動画基準と同じ)
 * - ja が主、 en を各行に併記 (= 1 本の動画で両 locale を賄い、 videoUrl を locale
 *   分岐させない)
 * - チェックポイントコード `TENKA{...}` の実値は動画に出さない (実環境の画面で
 *   手順を踏んだ人にだけ現れる、 というドリルの構造を守る)
 * - 各動画は合計 50〜65 秒 (script-data.test.ts が機械検証する)
 */

export interface OnboardingSlide {
  /** 左上 badge。 "INTRO" / "STEP n" / "NOTE" / "GOAL"。 */
  readonly badge: string;
  /** スライド表示秒数 (crossfade 分は render 側で吸収)。 */
  readonly durationS: number;
  readonly titleJa: string;
  readonly titleEn: string;
  /** 箇条書き (ja/en は index で対応。 長さ不一致は test が落とす)。 */
  readonly bulletsJa?: readonly string[];
  readonly bulletsEn?: readonly string[];
  /**
   * mono の強調チップ (コマンド / マスク済みチェックポイント表示など)。
   * tone: "step" = 青 (操作), "goal" = 緑 (達成)。
   */
  readonly code?: { readonly text: string; readonly tone: "step" | "goal" };
}

export interface OnboardingVideo {
  /** 出力ファイル名 (= fixture の videoUrl と揃える): landing/videos/onboarding/<problemId>.mp4 */
  readonly problemId: string;
  readonly titleJa: string;
  readonly titleEn: string;
  readonly slides: readonly OnboardingSlide[];
}

/** マスク表示 (実値は実環境の画面にだけ現れる)。 */
const MASKED_CODE = "TENKA{ ****** }";

export const ONBOARDING_VIDEOS: readonly OnboardingVideo[] = [
  {
    problemId: "what-is-tenkacloud",
    titleJa: "TenkaCloud とは?",
    titleEn: "What is TenkaCloud?",
    slides: [
      {
        badge: "INTRO",
        durationS: 7.5,
        titleJa: "TenkaCloud とは? を、触って知る",
        titleEn: "Learn what TenkaCloud is — by playing it",
        bulletsJa: ["説明を読むのではなく、1 問解く", "登録不要・ブラウザだけ・約 3 分"],
        bulletsEn: ["Don't read the pitch — solve one quest", "No signup, browser only, ~3 min"],
      },
      {
        badge: "STEP 1",
        durationS: 7.5,
        titleJa: "本物のクラウドの上で競技する",
        titleEn: "Compete on the real cloud",
        bulletsJa: ["「ローカルでは動く」を本番品質へ鍛える", "答えは本文の太字にある"],
        bulletsEn: ['From "works locally" to production-grade', "The answer is bold in the text"],
      },
      {
        badge: "STEP 2",
        durationS: 7.5,
        titleJa: "Battle と Challenge",
        titleEn: "Battle and Challenge",
        bulletsJa: ["リアルタイム対戦 = Battle", "自分のペースで挑む = Challenge"],
        bulletsEn: ["Real-time head-to-head = Battle", "Self-paced = Challenge"],
      },
      {
        badge: "STEP 3",
        durationS: 8.5,
        titleJa: "どこで動かす?",
        titleEn: "Where will you run it?",
        bulletsJa: [
          "ローカル — AWS 不要。Docker / Codespaces で動く",
          "Lite — 自分の AWS にデプロイして主催",
          "SaaS — マルチテナント展開(上級者向け)",
          "どれを選んでも正解",
        ],
        bulletsEn: [
          "Local — no AWS; runs on Docker / Codespaces",
          "Lite — deploy to your own AWS and host",
          "SaaS — multi-tenant, for advanced operators",
          "Any choice is correct",
        ],
      },
      {
        badge: "STEP 4",
        durationS: 8,
        titleJa: "flag を提出してみる",
        titleEn: "Submit your first flag",
        bulletsJa: ["練習用 flag は本文に印字済み", "貼るだけで +100 pt — 採点を初体験"],
        bulletsEn: [
          "The practice flag is printed in the text",
          "Paste it for +100 pt — first taste of scoring",
        ],
        code: { text: MASKED_CODE, tone: "step" },
      },
      {
        badge: "GOAL",
        durationS: 9,
        titleJa: "クリアで次の問題が開く",
        titleEn: "Clearing unlocks the next quest",
        bulletsJa: [
          "次は「自分の TenkaCloud Lite を立てる」",
          "AWS なしで遊ぶなら「ローカルモードで遊ぶ」も",
        ],
        bulletsEn: [
          'Next: "Deploy your own TenkaCloud Lite"',
          'No AWS yet? "Play local mode" awaits too',
        ],
      },
    ],
  },
  {
    problemId: "play-local-mode",
    titleJa: "ローカルモードで遊ぶ",
    titleEn: "Play local mode",
    slides: [
      {
        badge: "INTRO",
        durationS: 7,
        titleJa: "ローカルモードで遊ぶ",
        titleEn: "Play local mode",
        bulletsJa: ["AWS なしで本物の問題コンテナを動かす", "手元の Mac + Docker で起動"],
        bulletsEn: ["Real problem containers, no AWS account", "Runs on your Mac with Docker"],
      },
      {
        badge: "STEP 1",
        durationS: 7.5,
        titleJa: "Mac でローカルモードを起動",
        titleEn: "Start local mode on your Mac",
        bulletsJa: ["Docker を起動", "TenkaCloud リポジトリで make local"],
        bulletsEn: ["Start Docker", "Run make local in the TenkaCloud repo"],
      },
      {
        badge: "STEP 2",
        durationS: 7.5,
        titleJa: "ready 表示で Portal を確認",
        titleEn: "Find the Portal in the ready output",
        bulletsJa: ["Participant Portal ... 5175", "それがチェックポイント 1 の答え"],
        bulletsEn: ["Participant Portal ... 5175", "That is the answer to checkpoint 1"],
      },
      {
        badge: "STEP 3",
        durationS: 7,
        titleJa: "sqli-demo を開いて Start",
        titleEn: "Open sqli-demo and press Start",
        bulletsJa: ["Docker 対応の入門ドリルが最初に表示される", "コンテナが起動するまで少し待つ"],
        bulletsEn: [
          "The Docker-based intro drill is listed first",
          "Give the container a moment to start",
        ],
      },
      {
        badge: "STEP 4",
        durationS: 7,
        titleJa: "flag を見つけて提出",
        titleEn: "Find and submit the flag",
        bulletsJa: ["問題内の指示どおりに進めれば OK", "クリアすると解説 (writeup) が開く"],
        bulletsEn: ["Just follow the in-problem instructions", "Clearing it opens the writeup"],
      },
      {
        badge: "STEP 5",
        durationS: 7.5,
        titleJa: "writeup 末尾のコードをコピー",
        titleEn: "Copy the code from the writeup",
        bulletsJa: ["初クリアの writeup 末尾にだけ現れる", "実際に手を動かした人だけが手に入れる"],
        bulletsEn: ["It appears only after your first clear", "Only doing the work reveals it"],
        code: { text: MASKED_CODE, tone: "step" },
      },
      {
        badge: "GOAL",
        durationS: 8,
        titleJa: "デモポータルに貼って +100 pt",
        titleEn: "Paste it in the demo portal for +100 pt",
        bulletsJa: ["仕上げは「自分の TenkaCloud Lite を立てる」", "次はいよいよ本物の AWS へ"],
        bulletsEn: ['Finish with "Deploy your own TenkaCloud Lite"', "Next stop: real AWS"],
      },
    ],
  },
  {
    problemId: "deploy-tenkacloud-lite",
    titleJa: "自分の TenkaCloud Lite を立てる",
    titleEn: "Deploy your own TenkaCloud Lite",
    slides: [
      {
        badge: "INTRO",
        durationS: 7,
        titleJa: "自分の TenkaCloud Lite を立てる",
        titleEn: "Deploy your own TenkaCloud Lite",
        bulletsJa: [
          "本物の AWS に自分の競技基盤を立ち上げる",
          "約 $7/月 — 遊び終えたら必ず片付ける",
        ],
        bulletsEn: [
          "Stand up your own event platform on real AWS",
          "About $7/month — tear down when done",
        ],
      },
      {
        badge: "STEP 1",
        durationS: 8,
        titleJa: "Launcher スタックを作成",
        titleEn: "Create the launcher stack",
        bulletsJa: [
          "lite-pipeline.yaml を CloudFormation へ",
          "必須入力は TenantAdminEmail のみ",
          "スタックの Outputs にチェックポイント 1",
        ],
        bulletsEn: [
          "Create lite-pipeline.yaml in CloudFormation",
          "Only TenantAdminEmail is required",
          "Checkpoint 1 appears in the stack Outputs",
        ],
      },
      {
        badge: "STEP 2",
        durationS: 7.5,
        titleJa: "CodeBuild でデプロイ実行",
        titleEn: "Run the deploy in CodeBuild",
        bulletsJa: [
          "StartBuildConsoleUrl から「ビルドを開始」",
          "ログ末尾にチェックポイント 2 が印字される",
        ],
        bulletsEn: [
          "Open StartBuildConsoleUrl and start the build",
          "Checkpoint 2 prints at the end of the log",
        ],
      },
      {
        badge: "STEP 3",
        durationS: 7,
        titleJa: "Admin Console にサインイン",
        titleEn: "Sign in to the Admin Console",
        bulletsJa: ["招待メールの一時パスワードで入る", "ここからはブラウザ操作だけ"],
        bulletsEn: [
          "Use the invite email's temporary password",
          "Everything else is in the browser",
        ],
      },
      {
        badge: "STEP 4",
        durationS: 7.5,
        titleJa: "Competitor アカウントを検証",
        titleEn: "Verify a competitor account",
        bulletsJa: ["bootstrap テンプレートを適用して「検証」", "成功表示にチェックポイント 3"],
        bulletsEn: ["Apply the bootstrap template, then Verify", "Checkpoint 3 shows on success"],
      },
      {
        badge: "STEP 5",
        durationS: 7,
        titleJa: "初回イベントを作成",
        titleEn: "Create your first event",
        bulletsJa: ["検証済みアカウントをチームに割り当てる", "作成成功にチェックポイント 4"],
        bulletsEn: ["Assign the verified account to a team", "Checkpoint 4 shows on creation"],
      },
      {
        badge: "NOTE",
        durationS: 7,
        titleJa: "片付けもワンアクション",
        titleEn: "Teardown is one action",
        bulletsJa: [
          "ACTION=destroy でビルドを再実行",
          "最後に launcher スタックを削除して課金停止",
        ],
        bulletsEn: [
          "Re-run the build with ACTION=destroy",
          "Delete the launcher stack to stop billing",
        ],
      },
      {
        badge: "GOAL",
        durationS: 8,
        titleJa: "オンボーディング完走!",
        titleEn: "Onboarding complete!",
        bulletsJa: ["あなたの TenkaCloud が動いている", "次はあなたのイベントを開く番"],
        bulletsEn: ["Your own TenkaCloud is live", "Now go host your own event"],
        code: { text: "TENKA CLOUD — READY", tone: "goal" },
      },
    ],
  },
];

/**
 * #2696 P1: LP / README 用の 30 秒プロダクト動画 (問題冒頭の operation 動画とは別物)。
 * 実効尺 (crossfade 控除後) を 30 秒以内に収める (render.test.ts が機械検証)。
 * 現行ファネル (#2711: 1 問カード → チュートリアル → Lite) に合わせた構成。
 */
export const LP_VIDEO: OnboardingVideo = {
  problemId: "tenkacloud-30s",
  titleJa: "30 秒でわかる TenkaCloud",
  titleEn: "TenkaCloud in 30 seconds",
  slides: [
    {
      badge: "INTRO",
      durationS: 4.5,
      titleJa: "本物のクラウド演習を、遊ぶか。開催するか。",
      titleEn: "Real cloud drills — play them, or host them",
      bulletsJa: ["クラウドエンジニアの、天下一武道会", "OSS · Apache 2.0"],
      bulletsEn: ["The cloud engineer's Tenka-Ichi", "Open source · Apache 2.0"],
    },
    {
      badge: "PLAY",
      durationS: 5.5,
      titleJa: "まず遊ぶ — AWS 不要",
      titleEn: "Play first — no AWS",
      bulletsJa: [
        "LP の「最初の 1 問」から登録不要で開始",
        "チュートリアルを解きながら製品がわかる",
      ],
      bulletsEn: ["Start from the first quest — no signup", "Learn the product by solving it"],
    },
    {
      badge: "SCORE",
      durationS: 5.5,
      titleJa: "解いて、提出して、得点",
      titleEn: "Solve, submit, score",
      bulletsJa: ["flag 提出で +100 pt、スコアボードが動く", "詰まったらヒント (ペナルティなし)"],
      bulletsEn: ["Flags score +100 pt; the board moves live", "Hints are penalty-free"],
    },
    {
      badge: "LOCAL",
      durationS: 5.5,
      titleJa: "本物の問題コンテナも、AWS なしで",
      titleEn: "Real problem containers, still no AWS",
      bulletsJa: ["Mac + Docker で sqli-demo を起動", "ローカル採点で初得点まで数分"],
      bulletsEn: ["Run sqli-demo on your Mac with Docker", "Local scoring in minutes"],
    },
    {
      badge: "HOST",
      durationS: 5.5,
      titleJa: "イベントを開く — TenkaCloud Lite",
      titleEn: "Host your event — TenkaCloud Lite",
      bulletsJa: ["自分の AWS にメールアドレス 1 つで約 30 分", "片付けもワンアクション"],
      bulletsEn: ["Your AWS, one email address, ~30 min", "Teardown is one action"],
    },
    {
      badge: "GOAL",
      durationS: 3.5,
      titleJa: "tenkacloud.com",
      titleEn: "tenkacloud.com",
      bulletsJa: ["今すぐ 1 問解く", "AWS でイベントを開く"],
      bulletsEn: ["Solve your first quest now", "Host your own event on AWS"],
    },
  ],
};
