import type { Locale } from "@/lib/i18n";

// The marketing home and public catalog render from this one bilingual content
// model. Both locales share the same TypeScript shape, so a section that exists in
// one language must exist in the other — parity is a compile-time guarantee, not a
// review checklist (#1108: ja + en only). The copy is generic on purpose: it names
// "cloud competitions / hands-on drills", never a third-party event trademark, and
// carries no personal names.

export interface HeroCopy {
  readonly badge: string;
  readonly titleLead: string;
  readonly titleEm: string;
  readonly sub: string;
  readonly ctaCatalog: string;
  readonly ctaDemo: string;
  readonly ctaDevelopers: string;
  readonly ctaOss: string;
  readonly trust: string;
}

export interface ModeCopy {
  readonly kicker: string;
  readonly body: string;
}

export interface ModesCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lead: string;
  readonly battle: ModeCopy;
  readonly challenge: ModeCopy;
}

export interface AudienceItem {
  readonly role: string;
  readonly title: string;
  readonly body: string;
}

export interface AudiencesCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lead: string;
  readonly items: readonly [AudienceItem, AudienceItem, AudienceItem];
}

export interface OnboardingStep {
  readonly title: string;
  readonly body: string;
}

export interface OnboardingCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lead: string;
  readonly steps: readonly [OnboardingStep, OnboardingStep, OnboardingStep];
}

export interface SecurityCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly bullets: readonly string[];
}

export interface CatalogTeaserCopy {
  readonly eyebrow: string;
  readonly heading: string;
  // {ready}/{battle}/{challenge}/{total} are substituted from the live catalog data.
  readonly lead: string;
  readonly cta: string;
}

export interface OfferingTier {
  readonly tier: string;
  readonly price: string;
  readonly unit: string;
  readonly scope: string;
  readonly note: string;
  readonly features: readonly string[];
  readonly fineprint: string;
  readonly cta: string;
}

export interface OfferingsCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lead: string;
  readonly tiers: readonly [OfferingTier, OfferingTier, OfferingTier];
}

export interface ContactCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly body: string;
  readonly formCta: string;
  readonly discussionsCta: string;
  readonly fineprint: string;
}

export interface PageMeta {
  readonly title: string;
  readonly description: string;
}

export interface LangSwitchCopy {
  // Label of the link that switches to the OTHER language.
  readonly toOther: string;
  // Accessible label for the whole switch control.
  readonly ariaLabel: string;
}

export interface HomeCopy {
  readonly meta: PageMeta;
  readonly langSwitch: LangSwitchCopy;
  readonly hero: HeroCopy;
  readonly modes: ModesCopy;
  readonly audiences: AudiencesCopy;
  readonly onboarding: OnboardingCopy;
  readonly security: SecurityCopy;
  readonly catalog: CatalogTeaserCopy;
  readonly offerings: OfferingsCopy;
  readonly contact: ContactCopy;
  readonly legalLine: string;
}

export const HOME_COPY: Record<Locale, HomeCopy> = {
  ja: {
    meta: {
      title: "TenkaCloud — 本物の AWS で競う、OSS のクラウド競技プラットフォーム",
      description:
        "本物の AWS 環境で Battle と Challenge を開催できる OSS のクラウド実戦演習・競技プラットフォーム。チーム別環境、毎分採点、ランキング、再利用できる問題カタログ、運営画面を提供します。",
    },
    langSwitch: { toOther: "English", ariaLabel: "言語" },
    hero: {
      badge: "OSS · Apache 2.0",
      titleLead: "クラウドエンジニアの、",
      titleEm: "天下一。",
      sub: "本物の AWS で競う、OSS のクラウド競技プラットフォーム。「ローカルでは動く」アプリを本番品質へ ── 認証・公開範囲・監査・可用性の仕上がりを毎分自動採点し、順位がリアルタイムに動く。主催者はイベント・採点・再利用できる問題カタログを 1 画面で運営できます。",
      ctaCatalog: "問題カタログを見る",
      ctaDemo: "ライブデモを触る",
      ctaDevelopers: "ドキュメント",
      ctaOss: "GitHub で試す",
      trust: "合同会社 BULL 運営 · Apache License 2.0",
    },
    modes: {
      eyebrow: "2 つのモード",
      heading: "対戦か、演習か。両方か。",
      lead: "リアルタイムの Battle と、じっくり解く Challenge。1 つのイベントに混ぜて使えます。",
      battle: {
        kicker: "Battle（対戦）",
        body: "稼働率で競う、リアルタイム対戦。毎分のヘルスチェックを生き残ったチームが勝つ。障害注入からの復旧速度がそのまま点差になります。",
      },
      challenge: {
        kicker: "Challenge（演習）",
        body: "問題を解き、フラグを提出する。AWS の一つひとつのサービスを、自分のペースでひとつずつ理解していきます。",
      },
    },
    audiences: {
      eyebrow: "誰のための",
      heading: "クラウド実戦力を、組織で育てる。",
      lead: "クラウド人材育成（CCoE）／ Platform ／ SRE ／ Security 部門が、イベント基盤を自前で作らずにハンズオン AWS 演習を開催・運営できます。環境払い出し・ログイン・採点・進捗管理まで、ひとつの画面で完結します。",
      items: [
        {
          role: "CCoE / クラウド人材育成",
          title: "研修イベントを、年に複数回。",
          body: "新卒オンボーディング・内製化推進・部門横断の AWS 演習を、同じプラットフォームで年に複数回開催できます。単発ハンズオンから計画的な年間プログラムへ。",
        },
        {
          role: "Platform / SRE",
          title: "演習設計を、1 画面で。",
          body: "チームごとに隔離された AWS 環境を自動で配り、採点・進捗・Console アクセスを集約。1 週間かかっていた準備が半日に短縮され、facilitator の負荷も下がります。",
        },
        {
          role: "エンジニア / 個人参加",
          title: "実戦で、腕を上げる。",
          body: "本物の AWS で問題を解き、ランクを上げる。OSS なので、勉強会・学校・コミュニティが自前 AWS 環境で無料開催することもできます。",
        },
      ],
    },
    onboarding: {
      eyebrow: "オンボーディング",
      heading: "AWS との接続は、3 ステップ。",
      lead: "「自分のアカウントに何をされるか」をなくす設計。最小権限の AssumeRole 一本だけで、すべてが動きます。",
      steps: [
        {
          title: "テンプレートを、1 度だけ。",
          body: "CloudFormation を自分のアカウントに 1 回デプロイ。それで IAM Role が用意されます。",
        },
        {
          title: "ExternalId で、固く守る。",
          body: "TenkaCloud は固有の ExternalId 付きでしか、その Role を引き受けられません。Role ARN が漏れても入れません。",
        },
        {
          title: "ポータルから、競技へ。",
          body: "ログインすれば、問題環境が自動で立ち上がる。エンドポイントと点数は、その瞬間から見えます。",
        },
      ],
    },
    security: {
      eyebrow: "セキュリティ",
      heading: "あなたの AWS は、ずっとあなたのもの。",
      bullets: [
        "接続は最小権限の AssumeRole 一本のみ。TenkaCloud に長期のアクセスキーを預けません。",
        "AssumeRole には固有の ExternalId が必須。Role ARN が漏れても第三者は引き受けられません。",
        "問題はチームごとに隔離された環境へ配られ、参加者は個人 AWS アカウント不要でポータルからアクセスします。",
        "イベント運営データはイベント終了後に自動削除。参加者は個人アカウントを作らず、チーム単位の短命キーで認証します。",
      ],
    },
    catalog: {
      eyebrow: "問題カタログ",
      heading: "実戦問題は、公開されている。",
      lead: "今すぐプレイできる Battle {battle} 問と Challenge {challenge} 問を含む、合計 {total} 問の公開カタログ。すべて metadata.json + template.yaml の 2 ファイルで表現され、自分で追加することもできます。",
      cta: "問題カタログを見る",
    },
    offerings: {
      eyebrow: "商用プラン",
      heading: "イベント規模に合わせて。",
      lead: "プラットフォーム本体は Apache 2.0 の OSS なので、自前 AWS アカウントに deploy して開催すれば無料です。構築や当日運営を任せたい方向けに、規模に合わせた有料プランをご用意しています。",
      tiers: [
        {
          tier: "Starter",
          price: "50 万円",
          unit: "/ 回",
          scope: "お試し（〜 2 チーム）",
          note: "まずは小規模で運営代行を試したい方向け。",
          features: [
            "2 チームまでの同時開催",
            "deploy / 当日進行サポート",
            "公開問題セットから選定",
          ],
          fineprint: "※ AWS アカウントはお客様側でご用意ください。",
          cta: "お見積もりを依頼",
        },
        {
          tier: "Hosted Event",
          price: "150 万円",
          unit: "/ 回",
          scope: "5 チームまで（〜 20 人）",
          note: "構築から当日進行まで、運営を丸ごと代行します。",
          features: [
            "AWS アカウント準備 / deploy 支援",
            "当日の進行 + on-call / Red Team 役",
            "事後の振り返りレポート（採点履歴 / 攻撃可視化）",
            "問題セットの選定",
          ],
          fineprint:
            "※ AWS アカウントはお客様側でご用意ください。こちらで用意する場合は別途お見積もり。",
          cta: "お見積もりを依頼",
        },
        {
          tier: "Annual Arena",
          price: "600 万円",
          unit: "/ 年",
          scope: "年間契約（年 4 回のイベント開催を代行）",
          note: "新卒教育・内製化推進・CCoE プログラムなど、同じプラットフォームで年 4 回イベントを開催したい組織向け。",
          features: [
            "複数開催（年 4 回、部門別 / 期別）",
            "入門 → 中級 → 上級の learning path 提案 + facilitator 運営手順書テンプレート",
            "事後レポート PDF（採点履歴 / チーム別進捗 / 攻撃可視化、1 イベント 1 部）",
          ],
          fineprint: "※ 規模 / 内容に応じて見積もり。AWS アカウントはお客様側でご用意ください。",
          cta: "プログラムについて相談",
        },
      ],
    },
    contact: {
      eyebrow: "どのプランがよいか分からない",
      heading: "まずは話してみませんか。",
      body: "クラウド人材育成プログラム、内製化推進、継続的な AWS 演習 ── 規模・期間・参加者像を聞いた上で、適切なプランを一緒に決めます。",
      formCta: "お問い合わせフォーム",
      discussionsCta: "GitHub Discussions",
      fineprint:
        "フォームの回答は Google フォーム（Google が管理）に保存され、お問い合わせ対応と見積もり提示のみに利用します。",
    },
    legalLine: "プライバシーポリシー / 利用規約 / 特定商取引法に基づく表記",
  },
  en: {
    meta: {
      title: "TenkaCloud — Open-source cloud competitions on real AWS",
      description:
        "An OSS platform for running Battle and Challenge competitions on real AWS: per-team environments, per-minute scoring, live rankings, a reusable problem catalog, and one operator screen.",
    },
    langSwitch: { toOther: "日本語", ariaLabel: "Language" },
    hero: {
      badge: "OSS · Apache 2.0",
      titleLead: "The cloud engineer's ",
      titleEm: "arena.",
      sub: 'An OSS competition platform on real AWS. Take an app that "only works locally" and make it production-grade — auth, exposure, auditing, and uptime are scored automatically every minute, and the ranking moves in real time. Organizers run the event, the scoring, and a reusable problem catalog from one screen.',
      ctaCatalog: "Browse the catalog",
      ctaDemo: "Try the live demo",
      ctaDevelopers: "Documentation",
      ctaOss: "Try the OSS on GitHub",
      trust: "Operated by BULL LLC · Apache License 2.0",
    },
    modes: {
      eyebrow: "Two modes",
      heading: "Live battles. Solo challenges. Or both.",
      lead: "Real-time Battles and patient Challenges, in a single event if you want.",
      battle: {
        kicker: "Battle",
        body: "Uptime, in real time. A health check probes every team every minute — the last one standing wins. How fast you recover from an injected fault is your point spread.",
      },
      challenge: {
        kicker: "Challenge",
        body: "Solve the problem, submit the flag, earn the points. Learn one AWS service at a time, in depth, at your own pace.",
      },
    },
    audiences: {
      eyebrow: "Who it's for",
      heading: "Build cloud capability across the org.",
      lead: "For Cloud Enablement (CCoE), Platform / SRE, and Security teams that need hands-on AWS training — without rebuilding the event platform. Environment provisioning, login, scoring, and progress tracking, all in one screen.",
      items: [
        {
          role: "Cloud Enablement / CCoE",
          title: "Run training events multiple times a year.",
          body: "New-grad onboarding, internalization programs, cross-team AWS drills — run them multiple times a year on the same platform. Move from one-off workshops to a planned annual program.",
        },
        {
          role: "Platform / SRE",
          title: "Design drills from one screen.",
          body: "Each team gets an isolated AWS environment, automatically provisioned. Scoring, progress, and Console access are aggregated. A week of setup collapses to an afternoon, freeing up facilitators.",
        },
        {
          role: "Engineers / individual learners",
          title: "Sharpen on the real thing.",
          body: "Solve problems on live AWS infrastructure and climb the rank. The platform is OSS, so meetups, schools, and communities can also self-host on their own AWS account for free.",
        },
      ],
    },
    onboarding: {
      eyebrow: "Onboarding",
      heading: "Connect AWS in three steps.",
      lead: 'We designed away the "what\'s it going to do in my account?" question. One least-privilege AssumeRole — nothing more, nothing less.',
      steps: [
        {
          title: "Deploy the bootstrap, once.",
          body: "One CloudFormation template, deployed once into your account. An IAM Role is provisioned for us.",
        },
        {
          title: "Locked with ExternalId.",
          body: "TenkaCloud can only AssumeRole with a unique ExternalId. A leaked Role ARN gets you nowhere.",
        },
        {
          title: "Compete from the portal.",
          body: "Log in. Your problem stack deploys itself. Endpoints and scores are live the moment you land.",
        },
      ],
    },
    security: {
      eyebrow: "Security",
      heading: "Your AWS account, still yours.",
      bullets: [
        "The only connection is one least-privilege AssumeRole. You never hand TenkaCloud long-lived access keys.",
        "AssumeRole requires a unique ExternalId, so a leaked Role ARN cannot be assumed by anyone else.",
        "Problems deploy into per-team isolated environments; participants reach them from the portal with no individual AWS account.",
        "Event operation data is deleted automatically after the event. Participants create no personal accounts and authenticate with short-lived per-team keys.",
      ],
    },
    catalog: {
      eyebrow: "Problem catalog",
      heading: "The problems are in the open.",
      lead: "A public catalog of {total} problems, including {battle} Battles and {challenge} Challenges you can play right now. Every one is expressed as two files — metadata.json + template.yaml — so you can add your own.",
      cta: "Browse the catalog",
    },
    offerings: {
      eyebrow: "Commercial offerings",
      heading: "Start small. Move to a yearly program.",
      lead: "The platform itself is Apache 2.0 OSS, so hosting it on your own AWS account is free. For organizations that want setup or live operations run for them, we offer productized packages sized to the event.",
      tiers: [
        {
          tier: "Starter",
          price: "¥500K",
          unit: "/ event",
          scope: "Pilot (up to 2 teams)",
          note: "For first-time hosts who want to validate the operated experience at a small scale.",
          features: [
            "Up to 2 teams per pilot event",
            "Deploy / day-of support",
            "Selected from the public problem set",
          ],
          fineprint: "* You bring your own AWS account.",
          cta: "Request a quote",
        },
        {
          tier: "Hosted Event",
          price: "¥1.5M",
          unit: "/ event",
          scope: "Up to 5 teams / ~20 participants",
          note: "We handle setup, run the day, and tear down — one full event, operated.",
          features: [
            "AWS account prep / deploy support",
            "Live facilitation + on-call / Red Team role",
            "Post-event report (scoring history, attack timeline)",
            "Problem selection",
          ],
          fineprint:
            "* You bring your own AWS account. If we need to provide one, we quote separately.",
          cta: "Request a quote",
        },
        {
          tier: "Annual Arena",
          price: "¥6M",
          unit: "/ year",
          scope: "Annual contract — 4 operated events per year",
          note: "For organizations running new-grad training, internalization, or CCoE programs on one platform, four events a year.",
          features: [
            "Up to 4 events per year (by department / cohort)",
            "Beginner → intermediate → advanced learning path proposal + facilitator playbook template",
            "Post-event PDF report (scoring history, team progress, attack timeline — one per event)",
          ],
          fineprint: "* Quoted by scope and scale. You bring your own AWS account.",
          cta: "Talk about a program",
        },
      ],
    },
    contact: {
      eyebrow: "Not sure which plan fits",
      heading: "Let's talk.",
      body: "Cloud enablement programs, internal onboarding, recurring AWS drills — share your scale, cadence, and audience, and we'll figure out the right setup together.",
      formCta: "Open the contact form",
      discussionsCta: "GitHub Discussions",
      fineprint:
        "Responses are stored in a Google Form (managed by Google) and used only for replying and quoting.",
    },
    legalLine: "Privacy Policy / Terms of Service / Business identification (Japan TokushoHo)",
  },
};

export interface CatalogPageCopy {
  readonly meta: PageMeta;
  readonly langSwitch: LangSwitchCopy;
  readonly heading: string;
  // {ready}/{total} substituted from live catalog data.
  readonly lead: string;
  readonly categoryColumn: string;
  readonly difficultyColumn: string;
  readonly statusColumn: string;
  readonly tagsLabel: string;
  readonly readyLegend: string;
  readonly draftLegend: string;
  readonly sourceNote: string;
  readonly authorCta: string;
  readonly homeCta: string;
}

export const CATALOG_COPY: Record<Locale, CatalogPageCopy> = {
  ja: {
    meta: {
      title: "問題カタログ — TenkaCloud",
      description:
        "TenkaCloud で開催できる Battle / Challenge 問題の公開カタログ。難易度・状態・タグとともに一覧できます。",
    },
    langSwitch: { toOther: "English", ariaLabel: "言語" },
    heading: "問題カタログ",
    lead: "本物の AWS で開催できる公開問題は合計 {total} 問。うち {ready} 問が今すぐプレイできます（準備中の問題は「準備中」と表示しています）。",
    categoryColumn: "カテゴリ",
    difficultyColumn: "難易度",
    statusColumn: "状態",
    tagsLabel: "タグ",
    readyLegend: "公開中：今すぐプレイできます",
    draftLegend: "準備中：制作中のためまだ提供していません",
    sourceNote:
      "このカタログは問題の metadata.json（TenkaCloudChallenge リポジトリ）から生成しています。",
    authorCta: "自分で問題を作る",
    homeCta: "ホームに戻る",
  },
  en: {
    meta: {
      title: "Problem catalog — TenkaCloud",
      description:
        "The public catalog of Battle and Challenge problems you can run on TenkaCloud, listed with difficulty, status, and tags.",
    },
    langSwitch: { toOther: "日本語", ariaLabel: "Language" },
    heading: "Problem catalog",
    lead: 'There are {total} public problems you can run on real AWS. {ready} of them are playable right now (problems still being prepared are marked "In development").',
    categoryColumn: "Category",
    difficultyColumn: "Difficulty",
    statusColumn: "Status",
    tagsLabel: "Tags",
    readyLegend: "Available: playable right now",
    draftLegend: "In development: being prepared, not yet available",
    sourceNote:
      "This catalog is generated from each problem's metadata.json (the TenkaCloudChallenge repository).",
    authorCta: "Author your own problem",
    homeCta: "Back to home",
  },
};
