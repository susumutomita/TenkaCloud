'use client';

import { motion } from 'framer-motion';
import { Code2, Database, Globe2, Shield, TrendingUp, Zap } from 'lucide-react';

const features = [
  {
    icon: Zap,
    title: '5分で本番環境',
    description:
      'クリックだけで Kubernetes、データベース、認証基盤を自動デプロイ。インフラの知識は不要です。',
  },
  {
    icon: Shield,
    title: 'エンタープライズグレードのセキュリティ',
    description:
      'Keycloak による OIDC 認証、テナント間の完全なデータ分離、SOC2 準拠の運用体制。',
  },
  {
    icon: TrendingUp,
    title: '無限のスケーラビリティ',
    description:
      '10人から10,000人まで。Kubernetes の自動スケーリングで参加者数に合わせてリソースを最適化。',
  },
  {
    icon: Code2,
    title: 'マルチ言語対応ジャッジ',
    description:
      'Python、JavaScript、Go、Rust など主要言語をサポート。独自の実行環境も追加可能。',
  },
  {
    icon: Database,
    title: 'Pool & Silo アーキテクチャ',
    description:
      '用途に応じて共有リソース (Pool) と専用リソース (Silo) を選択。コスト効率と分離性のバランスを最適化。',
  },
  {
    icon: Globe2,
    title: 'マルチクラウド対応',
    description:
      'AWS、GCP、Azure、OCI をサポート。ベンダーロックインなしで、最適なクラウドを選択できます。',
  },
];

export function FeaturesSection() {
  return (
    <section className="section-padding">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center space-y-4 mb-20"
        >
          <h2 className="text-5xl sm:text-6xl font-bold gradient-text">
            必要なすべてが、揃っている
          </h2>
          <p className="text-xl text-white/70 max-w-2xl mx-auto">
            プログラミングコンテスト運営に必要な機能を、すべて標準装備。
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          {features.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                className="group"
              >
                <div className="h-full p-8 glass rounded-2xl hover:border-primary-500/50 transition-all">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary-500 to-accent-500 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                    <Icon className="w-6 h-6 text-white" />
                  </div>

                  <h3 className="text-xl font-semibold text-white mb-3">
                    {feature.title}
                  </h3>

                  <p className="text-white/70 leading-relaxed">
                    {feature.description}
                  </p>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
