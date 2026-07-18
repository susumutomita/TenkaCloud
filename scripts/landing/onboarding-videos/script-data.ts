/**
 * #2707 P1: オンボーディング 3 部作の 1 分 operation 動画の台本 (source of truth)。
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
    problemId: "understand-tenkacloud",
    titleJa: "TenkaCloud を理解する",
    titleEn: "Understand TenkaCloud",
    slides: [
      {
        badge: "INTRO",
        durationS: 7,
        titleJa: "TenkaCloud を理解する",
        titleEn: "Understand TenkaCloud",
        bulletsJa: ["読んで、答えて、得点する最初の 1 問", "ブラウザだけ・登録不要"],
        bulletsEn: ["Read, answer, and score your first problem", "Browser only — no signup"],
      },
      {
        badge: "STEP 1",
        durationS: 7,
        titleJa: "問題文を読む",
        titleEn: "Read the problem text",
        bulletsJa: ["4 問の答えはすべて本文の中にある", "まず一度スクロールして全体を眺める"],
        bulletsEn: ["All four answers are in the text itself", "Scroll once to see the whole page"],
      },
      {
        badge: "STEP 2",
        durationS: 7.5,
        titleJa: "2 つの競技カテゴリ",
        titleEn: "Two competition categories",
        bulletsJa: ["リアルタイム対戦 = Battle", "自分のペースで挑む = Challenge"],
        bulletsEn: ["Real-time head-to-head = Battle", "Self-paced = Challenge"],
      },
      {
        badge: "STEP 3",
        durationS: 7,
        titleJa: "競技者が見る画面",
        titleEn: "The competitor's screen",
        bulletsJa: [
          "いま開いているこの画面が Participant Portal",
          "スコア・問題・ヒントがここに集まる",
        ],
        bulletsEn: [
          "This very screen is the Participant Portal",
          "Scores, problems, and hints all live here",
        ],
      },
      {
        badge: "STEP 4",
        durationS: 7,
        titleJa: "1 アカウントで立てる構成",
        titleEn: "The one-account setup",
        bulletsJa: [
          "AWS アカウント 1 つで主催できるのが Lite モード",
          "3 問目で実際にデプロイする",
        ],
        bulletsEn: ["Lite mode hosts on a single AWS account", "You will deploy it in problem 3"],
      },
      {
        badge: "STEP 5",
        durationS: 7.5,
        titleJa: "答えを提出する",
        titleEn: "Submit your answers",
        bulletsJa: ["各提出欄に入力して +50 pt × 4", "詰まったらヒントを開く (ペナルティなし)"],
        bulletsEn: ["Each box scores +50 pt, four in total", "Stuck? Hints are penalty-free"],
      },
      {
        badge: "GOAL",
        durationS: 8,
        titleJa: "200 pt で問題 1 クリア",
        titleEn: "200 pt clears problem 1",
        bulletsJa: ["次は「ローカルモードで遊ぶ」へ", "本物の問題コンテナを AWS なしで動かす"],
        bulletsEn: ['Next up: "Play local mode"', "Run real problem containers with no AWS"],
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
        bulletsJa: ["AWS なしで本物の問題コンテナを動かす", "ブラウザだけなら Codespaces が最短"],
        bulletsEn: [
          "Real problem containers, no AWS account",
          "Codespaces is the fastest browser-only route",
        ],
      },
      {
        badge: "STEP 1",
        durationS: 7.5,
        titleJa: "Codespace を作る",
        titleEn: "Create a Codespace",
        bulletsJa: ["GitHub で Code ▸ Codespaces ▸ Create", "初回起動は数分待つ"],
        bulletsEn: ["On GitHub: Code ▸ Codespaces ▸ Create", "First boot takes a few minutes"],
      },
      {
        badge: "STEP 2",
        durationS: 7.5,
        titleJa: "Portal が自動で開く",
        titleEn: "The Portal opens itself",
        bulletsJa: ["ポート番号は Ports タブで確認できる", "それがチェックポイント 1 の答え"],
        bulletsEn: ["Find the port number in the Ports tab", "That is the answer to checkpoint 1"],
      },
      {
        badge: "STEP 3",
        durationS: 7,
        titleJa: "hello-world を開いて Start",
        titleEn: "Open hello-world and press Start",
        bulletsJa: ["固定の入門ドリルが最初に表示される", "コンテナが起動するまで少し待つ"],
        bulletsEn: [
          "The fixed intro drill is listed first",
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
        titleJa: "3 部作完走!",
        titleEn: "Trilogy complete!",
        bulletsJa: ["あなたの TenkaCloud が動いている", "次はあなたのイベントを開く番"],
        bulletsEn: ["Your own TenkaCloud is live", "Now go host your own event"],
        code: { text: "TENKA CLOUD — READY", tone: "goal" },
      },
    ],
  },
];
