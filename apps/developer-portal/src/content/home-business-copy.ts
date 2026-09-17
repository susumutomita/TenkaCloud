import type { Locale } from "@/lib/i18n";

// Business-first narrative for the marketing home. The product catalogue, pricing,
// security details, and legal copy remain in site-copy.ts; this model owns the order
// in which an enterprise buyer evaluates TenkaCloud: problem -> value -> economics ->
// stakeholders -> use cases -> operating model. One shared shape keeps JA/EN parity.

export interface HomeBusinessMeta {
  readonly title: string;
  readonly description: string;
}

export interface HomeBusinessHero {
  readonly badge: string;
  readonly titleLead: string;
  readonly titleEm: string;
  readonly sub: string;
  readonly primaryCta: string;
  readonly secondaryCta: string;
  readonly tertiaryCta: string;
  readonly proof: readonly [string, string, string];
}

export interface NarrativeCard {
  readonly label: string;
  readonly title: string;
  readonly body: string;
}

export interface NarrativeSection {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lead: string;
  readonly items: readonly [NarrativeCard, NarrativeCard, NarrativeCard];
}

export interface TransformationColumn {
  readonly label: string;
  readonly title: string;
  readonly items: readonly string[];
}

export interface TransformationCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lead: string;
  readonly before: TransformationColumn;
  readonly after: TransformationColumn;
  readonly outcome: string;
}

export interface EconomicMetric {
  readonly code: string;
  readonly label: string;
  readonly body: string;
}

export interface EconomicsCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lead: string;
  readonly items: readonly [EconomicMetric, EconomicMetric, EconomicMetric, EconomicMetric];
  readonly note: string;
}

export interface StakeholderCopy {
  readonly role: string;
  readonly title: string;
  readonly body: string;
}

export interface StakeholdersCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lead: string;
  readonly items: readonly [StakeholderCopy, StakeholderCopy, StakeholderCopy, StakeholderCopy];
}

export interface UseCaseCopy {
  readonly label: string;
  readonly title: string;
  readonly body: string;
}

export interface UseCasesCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lead: string;
  readonly items: readonly [UseCaseCopy, UseCaseCopy, UseCaseCopy, UseCaseCopy];
}

export interface OperationStep {
  readonly title: string;
  readonly body: string;
}

export interface OperationsCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lead: string;
  readonly steps: readonly [OperationStep, OperationStep, OperationStep, OperationStep];
}

export interface HomeBusinessCopy {
  readonly meta: HomeBusinessMeta;
  readonly hero: HomeBusinessHero;
  readonly problems: NarrativeSection;
  readonly transformation: TransformationCopy;
  readonly economics: EconomicsCopy;
  readonly stakeholders: StakeholdersCopy;
  readonly useCases: UseCasesCopy;
  readonly operations: OperationsCopy;
}

export const BUSINESS_HOME_COPY: Record<Locale, HomeBusinessCopy> = {
  ja: {
    meta: {
      title: "TenkaCloud — クラウド実戦力を組織で育てる実環境演習プラットフォーム",
      description:
        "TenkaCloudは、AWS実環境を使った演習を、環境払い出し・ログイン・自動採点・進捗管理・振り返りまで標準化するクラウド人材育成プラットフォームです。",
    },
    hero: {
      badge: "クラウド人材育成 · 実環境演習",
      titleLead: "座学では測れないクラウド実戦力を、",
      titleEm: "組織で育てる。",
      sub: "TenkaCloudは、AWSの実環境を使った演習・競技を、環境払い出し、ログイン、自動採点、進捗管理、振り返りまで標準化します。年に一度の特別な実践演習ではなく、組織が繰り返せる育成プログラムへ変えます。",
      primaryCta: "企業導入を相談する",
      secondaryCta: "3分で体験する",
      tertiaryCta: "問題カタログを見る",
      proof: ["Apache 2.0 OSS", "自社AWSアカウントで運用可能", "構築・当日運営の支援あり"],
    },
    problems: {
      eyebrow: "THE PROBLEM",
      heading: "知識を教えるだけでは、本番で動けるか分からない。",
      lead: "クラウド運用で必要なのは、状況を読み、AWSを操作し、チームで判断する力です。しかし実環境演習を継続するには、教材以外の運営負荷が大きすぎます。",
      items: [
        {
          label: "01 / SKILL GAP",
          title: "実戦力を確認できない",
          body: "資格や受講履歴だけでは、障害時に自ら判断し、環境を変更し、復旧まで進められるかを確認できません。",
        },
        {
          label: "02 / OPERATIONS",
          title: "開催準備が重い",
          body: "AWS環境、権限、参加者ログイン、問題配布、採点、進行、クリーンアップを開催のたびに組み直す必要があります。",
        },
        {
          label: "03 / CONTINUITY",
          title: "単発イベントで終わる",
          body: "一度開催しても、問題、運営手順、評価結果が再利用されず、年間の育成プログラムとして蓄積されません。",
        },
      ],
    },
    transformation: {
      eyebrow: "THE VALUE",
      heading: "単発の演習を、継続できる育成基盤へ。",
      lead: "TenkaCloudは、教材だけではなく、実環境演習を開催するための一連の業務を標準化します。",
      before: {
        label: "BEFORE",
        title: "開催ごとに個別対応",
        items: [
          "問題と採点方法を準備する",
          "AWS環境と権限を構築する",
          "参加者ごとにアクセス方法を案内する",
          "当日の進捗を人手で追う",
          "終了後に結果を集計する",
          "環境を片付け、次回また作り直す",
        ],
      },
      after: {
        label: "AFTER",
        title: "再利用できる運営基盤",
        items: [
          "問題カタログから演習を選ぶ",
          "チームを登録し環境をデプロイする",
          "ポータルからAWSへログインする",
          "採点と進捗を自動で集約する",
          "結果を振り返りに使う",
          "同じ仕組みで次回を開催する",
        ],
      },
      outcome: "実践型研修を「特別なイベント」から「組織が繰り返せる仕組み」へ変える。",
    },
    economics: {
      eyebrow: "BUSINESS CASE",
      heading: "楽しさではなく、運営コストと開催頻度で評価する。",
      lead: "導入効果は、ゲーム性だけではなく、開催準備・当日運営・採点・教材再作成に使う人日と、年間に何回実施できるかで測ります。",
      items: [
        {
          code: "TIME TO READY",
          label: "開催準備時間",
          body: "開催決定から、参加者が演習を開始できる状態になるまでの時間。",
        },
        {
          code: "OPS / EVENT",
          label: "1回あたり運営工数",
          body: "環境準備、当日進行、採点、集計、クリーンアップに必要な人日。",
        },
        {
          code: "EVENTS / YEAR",
          label: "年間開催回数",
          body: "単発で終わらず、部門・期・難易度を変えて継続できているか。",
        },
        {
          code: "REUSE RATE",
          label: "問題・手順の再利用率",
          body: "作成した教材と運営手順が、次回以降の開催で再利用されているか。",
        },
      ],
      note: "商談では、現在の開催手順と各工程の人日を確認し、導入前後の差分からROIを設計します。",
    },
    stakeholders: {
      eyebrow: "WHO DECIDES",
      heading: "使う人と、導入を決める人は違う。",
      lead: "TenkaCloudは、参加者だけでなく、予算、運営、セキュリティの各責任者に価値が成立して初めて導入できます。",
      items: [
        {
          role: "BUYER / CIO・CTO・CCoE",
          title: "実戦型育成を年間施策にする",
          body: "研修を単発イベントではなく、組織能力を高める継続プログラムとして設計できます。",
        },
        {
          role: "OPERATOR / PLATFORM・SRE・研修担当",
          title: "個別運営を標準化する",
          body: "環境払い出し、アクセス、採点、進捗、振り返りを一つの運営フローにまとめます。",
        },
        {
          role: "APPROVER / SECURITY・情報システム",
          title: "自社AWSの統制を維持する",
          body: "長期アクセスキーを預けず、AssumeRoleとExternalIdを使った接続モデルで開催できます。",
        },
        {
          role: "USER / エンジニア・新卒・異動者",
          title: "本物の環境で判断する",
          body: "手順をなぞるだけでなく、変更、障害、復旧、改善を自分の判断で経験できます。",
        },
      ],
    },
    useCases: {
      eyebrow: "USE CASES",
      heading: "育成目的に合わせて、実戦演習を組み立てる。",
      lead: "同じ基盤を、オンボーディング、内製化、障害対応、セキュリティ教育へ横展開できます。",
      items: [
        {
          label: "ONBOARDING",
          title: "新卒・異動者の立ち上げ",
          body: "基本操作からIAM、ネットワーク、監視まで、難易度を段階的に上げる学習導線を作ります。",
        },
        {
          label: "CCoE",
          title: "クラウド内製化・部門横断研修",
          body: "複数部門が同じ演習へ参加し、組織内のスキルと共通課題を実環境で確認します。",
        },
        {
          label: "SRE",
          title: "障害対応・可用性訓練",
          body: "稼働状況がスコアへ反映されるBattleで、変更判断、復旧、チーム連携を訓練します。",
        },
        {
          label: "SECURITY",
          title: "DevSecOps・公開前レビュー",
          body: "認証、公開範囲、権限、監査など、本番公開に必要な判断を実際の環境で学びます。",
        },
      ],
    },
    operations: {
      eyebrow: "OPERATING MODEL",
      heading: "設計から振り返りまで、4つのステップ。",
      lead: "セルフホストでも運営代行でも、誰が何を担当するかを明確にして開催します。",
      steps: [
        {
          title: "育成目標と問題を決める",
          body: "対象者、身につけるスキル、難易度を定義し、公開カタログまたは独自問題から構成します。",
        },
        {
          title: "チームごとの環境を用意する",
          body: "主催者のAWSアカウントへ問題をデプロイし、チームとアクセス先を割り当てます。",
        },
        {
          title: "演習・競技を実施する",
          body: "参加者はポータルから問題とAWS Consoleを開き、ChallengeまたはBattleへ参加します。",
        },
        {
          title: "結果を振り返り、再利用する",
          body: "採点履歴と進捗を確認し、次回の問題選定、育成計画、運営手順へ反映します。",
        },
      ],
    },
  },
  en: {
    meta: {
      title: "TenkaCloud — Build cloud operating skills through hands-on environments",
      description:
        "TenkaCloud standardizes hands-on AWS training from environment provisioning and sign-in to automated scoring, progress tracking, and review.",
    },
    hero: {
      badge: "Cloud workforce development · Hands-on environments",
      titleLead: "Build the cloud skills lectures cannot measure,",
      titleEm: "across your organization.",
      sub: "TenkaCloud standardizes hands-on AWS drills and competitions: environment provisioning, sign-in, automated scoring, progress tracking, and review. Turn a once-a-year special event into a repeatable workforce development program.",
      primaryCta: "Discuss enterprise adoption",
      secondaryCta: "Try it in 3 minutes",
      tertiaryCta: "Browse the catalog",
      proof: ["Apache 2.0 OSS", "Runs in your AWS account", "Setup and live operations available"],
    },
    problems: {
      eyebrow: "THE PROBLEM",
      heading: "Teaching knowledge does not prove someone can operate in production.",
      lead: "Cloud operations require people to read a situation, change AWS resources, and make decisions as a team. Yet the operational cost of running realistic exercises makes them difficult to repeat.",
      items: [
        {
          label: "01 / SKILL GAP",
          title: "Practical ability stays invisible",
          body: "Certificates and attendance records do not show whether someone can diagnose an incident, change an environment, and carry the work through recovery.",
        },
        {
          label: "02 / OPERATIONS",
          title: "Every event is expensive to prepare",
          body: "AWS environments, permissions, participant access, problem distribution, scoring, facilitation, and cleanup are rebuilt for every session.",
        },
        {
          label: "03 / CONTINUITY",
          title: "Exercises remain one-off events",
          body: "Problems, operating procedures, and assessment results are not reused, so the event never compounds into an annual development program.",
        },
      ],
    },
    transformation: {
      eyebrow: "THE VALUE",
      heading: "Turn one-off drills into a repeatable development platform.",
      lead: "TenkaCloud standardizes not only the training content, but the complete operating workflow required to run hands-on environments.",
      before: {
        label: "BEFORE",
        title: "Rebuild the event every time",
        items: [
          "Prepare problems and scoring rules",
          "Build AWS environments and permissions",
          "Explain access to every participant",
          "Track progress manually during the event",
          "Aggregate results after the event",
          "Clean up and rebuild everything next time",
        ],
      },
      after: {
        label: "AFTER",
        title: "Operate on a reusable foundation",
        items: [
          "Choose exercises from the catalog",
          "Register teams and deploy environments",
          "Open AWS through the participant portal",
          "Collect scoring and progress automatically",
          "Use results for structured review",
          "Run the next event on the same foundation",
        ],
      },
      outcome:
        "Move hands-on training from a special event to an organizational capability that can be repeated.",
    },
    economics: {
      eyebrow: "BUSINESS CASE",
      heading: "Evaluate it by operating cost and training frequency, not entertainment value.",
      lead: "The business case is measured in the people-days spent on preparation, live operations, scoring, and content recreation—and in how often the organization can run the program each year.",
      items: [
        {
          code: "TIME TO READY",
          label: "Preparation lead time",
          body: "The time from deciding to run an event until participants can begin the exercise.",
        },
        {
          code: "OPS / EVENT",
          label: "Operations effort per event",
          body: "People-days required for setup, facilitation, scoring, reporting, and cleanup.",
        },
        {
          code: "EVENTS / YEAR",
          label: "Annual training frequency",
          body: "Whether the program can be repeated across departments, cohorts, and difficulty levels.",
        },
        {
          code: "REUSE RATE",
          label: "Content and process reuse",
          body: "How much of the problem set and operating procedure is reused in later events.",
        },
      ],
      note: "During discovery, we map the current operating workflow and its people-days, then build the ROI case from the before-and-after delta.",
    },
    stakeholders: {
      eyebrow: "WHO DECIDES",
      heading: "The user, buyer, operator, and approver are different people.",
      lead: "TenkaCloud is adoptable only when it creates value for participants, budget owners, operators, and security stakeholders at the same time.",
      items: [
        {
          role: "BUYER / CIO, CTO, CCoE",
          title: "Make hands-on development an annual program",
          body: "Design training as a repeatable organizational capability instead of a collection of isolated events.",
        },
        {
          role: "OPERATOR / PLATFORM, SRE, TRAINING",
          title: "Standardize event operations",
          body: "Bring environment provisioning, access, scoring, progress, and review into one operating workflow.",
        },
        {
          role: "APPROVER / SECURITY, IT",
          title: "Keep control of the AWS environment",
          body: "Run events with an AssumeRole and ExternalId model without handing over long-lived access keys.",
        },
        {
          role: "USER / ENGINEERS, NEW HIRES",
          title: "Make decisions in a real environment",
          body: "Experience changes, failures, recovery, and improvement rather than following a fixed sequence of instructions.",
        },
      ],
    },
    useCases: {
      eyebrow: "USE CASES",
      heading: "Design practical exercises around the capability you need to build.",
      lead: "Use the same foundation for onboarding, cloud enablement, incident response, and security education.",
      items: [
        {
          label: "ONBOARDING",
          title: "New-hire and role-transition onboarding",
          body: "Build a progressive path from basic AWS operations through IAM, networking, observability, and production judgment.",
        },
        {
          label: "CCoE",
          title: "Cloud enablement across departments",
          body: "Put multiple departments through the same exercises and surface shared capability gaps in real environments.",
        },
        {
          label: "SRE",
          title: "Incident response and availability drills",
          body: "Use continuously scored Battles to train change decisions, recovery, and team coordination.",
        },
        {
          label: "SECURITY",
          title: "DevSecOps and pre-production review",
          body: "Practice the authentication, exposure, authorization, and audit decisions required before production release.",
        },
      ],
    },
    operations: {
      eyebrow: "OPERATING MODEL",
      heading: "From design to review in four steps.",
      lead: "Whether self-hosted or operated for you, the model makes ownership and responsibilities explicit before the event begins.",
      steps: [
        {
          title: "Define the capability and select problems",
          body: "Set the audience, target skills, and difficulty, then compose a path from the public catalog or private problems.",
        },
        {
          title: "Provision an environment for each team",
          body: "Deploy problems into the organizer's AWS account and assign teams to their access targets.",
        },
        {
          title: "Run the drill or competition",
          body: "Participants open problems and AWS Console from the portal and work through Challenge or Battle mode.",
        },
        {
          title: "Review results and reuse the program",
          body: "Use scoring history and progress to improve the next problem set, development plan, and operating procedure.",
        },
      ],
    },
  },
};
