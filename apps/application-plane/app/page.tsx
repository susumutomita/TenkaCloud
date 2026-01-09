'use client';

import {
  Award,
  Cloud,
  Code2,
  Rocket,
  Shield,
  Target,
  Trophy,
  Users,
  Zap,
} from 'lucide-react';
import Link from 'next/link';

const stats = [
  { value: '3+', label: 'Cloud Providers' },
  { value: '100+', label: 'Problems' },
  { value: '24/7', label: 'Auto Grading' },
  { value: '1000+', label: 'Engineers' },
];

const features = [
  {
    icon: Cloud,
    title: 'マルチクラウド対応',
    description: 'AWS / GCP / Azure の実環境で腕試し',
  },
  {
    icon: Code2,
    title: '実践的な課題',
    description: 'インフラ構築・セキュリティ・コスト最適化',
  },
  {
    icon: Users,
    title: 'チーム or 個人',
    description: '仲間と協力、またはソロで挑戦',
  },
  {
    icon: Trophy,
    title: 'リアルタイム採点',
    description: '自動採点で即座にフィードバック',
  },
];

const eventTypes = [
  {
    icon: Zap,
    name: 'GameDay',
    description:
      '障害対応シミュレーション。本番さながらのインシデント対応を体験',
    tags: ['Incident Response', 'Troubleshooting'],
  },
  {
    icon: Shield,
    name: 'Jam',
    description:
      'セキュリティ・最適化課題。制限時間内に課題を解いてスコアを競う',
    tags: ['Security', 'Optimization'],
  },
];

export default function Home(): React.JSX.Element {
  return (
    <div className="min-h-screen">
      {/* Hero Section */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-20 md:py-28">
        <div className="space-y-6">
          <p className="text-hn-accent font-medium tracking-wide uppercase text-sm">
            Cloud Competition Platform
          </p>
          <h1 className="font-display text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-text-primary">
            クラウドスキルを競い
            <br />
            <span className="text-hn-accent">高め合う場所</span>
          </h1>
          <p className="text-xl md:text-2xl text-text-muted max-w-3xl">
            AWS・GCP・Azure
            の実環境で、インフラ構築・障害対応・セキュリティの腕を競う。
            最強のクラウドエンジニアを目指せ。
          </p>
          <div className="flex flex-wrap gap-4 pt-4">
            <Link
              href="/events"
              className="inline-flex items-center px-6 py-3 bg-hn-accent hover:bg-hn-accent-muted text-surface-0 font-medium rounded-lg transition-colors"
            >
              イベントを探す
              <Rocket className="w-4 h-4 ml-2" />
            </Link>
            <Link
              href="/rankings"
              className="inline-flex items-center px-6 py-3 border border-border hover:border-hn-accent font-medium rounded-lg transition-colors"
            >
              <Award className="w-4 h-4 mr-2" />
              ランキングを見る
            </Link>
          </div>
        </div>
      </section>

      {/* Stats Section */}
      <section className="bg-surface-1 border-y border-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            {stats.map((stat) => (
              <div key={stat.label} className="text-center">
                <div className="font-mono text-3xl md:text-4xl font-bold text-hn-accent">
                  {stat.value}
                </div>
                <div className="text-sm text-text-muted mt-1">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* What is TenkaCloud Section */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="font-display text-2xl md:text-3xl font-bold text-text-primary">
              TenkaCloud とは
            </h2>
            <p className="text-text-muted mt-2">
              クラウドエンジニアのための競技プラットフォーム
            </p>
          </div>
        </div>
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="p-6 rounded-lg border border-border hover:border-hn-accent transition-colors"
            >
              <div className="w-12 h-12 rounded-lg bg-hn-accent/10 flex items-center justify-center mb-4">
                <feature.icon className="w-6 h-6 text-hn-accent" />
              </div>
              <h3 className="font-display font-semibold text-lg mb-2 text-text-primary">
                {feature.title}
              </h3>
              <p className="text-sm text-text-muted">{feature.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Event Types Section */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-16 border-t border-border">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="font-display text-2xl md:text-3xl font-bold text-text-primary">
              イベントタイプ
            </h2>
            <p className="text-text-muted mt-2">
              目的に合わせて、2種類のイベント形式から選択
            </p>
          </div>
          <Link
            href="/events"
            className="text-sm font-medium text-hn-accent hover:text-hn-accent-muted transition-colors hidden md:block"
          >
            すべてのイベント →
          </Link>
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          {eventTypes.map((type) => (
            <Link
              key={type.name}
              href="/events"
              className="group block p-6 rounded-lg border-2 border-border hover:border-hn-accent transition-all hover:shadow-lg"
            >
              <div className="flex flex-wrap gap-2 mb-3">
                {type.tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-2 py-0.5 text-xs font-medium bg-hn-accent/10 text-hn-accent rounded-full"
                  >
                    {tag}
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-hn-accent/10 flex items-center justify-center group-hover:bg-hn-accent/20 transition-colors">
                  <type.icon className="w-5 h-5 text-hn-accent" />
                </div>
                <h3 className="font-display text-xl font-bold text-text-primary group-hover:text-hn-accent transition-colors">
                  {type.name}
                </h3>
              </div>
              <p className="text-text-muted text-sm">{type.description}</p>
              <div className="flex items-center gap-2 mt-4 text-hn-accent text-sm font-medium">
                <span>イベントを見る</span>
                <svg
                  className="w-4 h-4 group-hover:translate-x-1 transition-transform"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 8l4 4m0 0l-4 4m4-4H3"
                  />
                </svg>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* CTA Section */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="p-8 md:p-12 rounded-2xl bg-gradient-to-br from-hn-accent/10 to-hn-info/5 border border-hn-accent/20 text-center">
          <div className="w-12 h-12 mx-auto mb-6 rounded-full bg-hn-accent/10 flex items-center justify-center">
            <Target className="w-6 h-6 text-hn-accent" />
          </div>
          <h2 className="font-display text-2xl md:text-3xl font-bold text-text-primary mb-4">
            まずは観戦してみよう
          </h2>
          <p className="text-text-muted mb-6 max-w-xl mx-auto">
            アカウント不要で、開催中のイベントやランキングを閲覧できます。
            どんな課題があるのか、どんな人が参加しているのか、まずはチェック。
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <Link
              href="/events"
              className="inline-flex items-center px-6 py-3 bg-hn-accent hover:bg-hn-accent-muted text-surface-0 font-medium rounded-lg transition-colors"
            >
              イベント一覧を見る
            </Link>
            <Link
              href="/rankings"
              className="inline-flex items-center px-6 py-3 border border-border hover:border-hn-accent font-medium rounded-lg transition-colors"
            >
              ランキングを見る
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 px-4 border-t border-border">
        <div className="max-w-5xl mx-auto text-center text-text-muted text-sm">
          <p>TenkaCloud - The Open Cloud Battle Arena</p>
        </div>
      </footer>
    </div>
  );
}
