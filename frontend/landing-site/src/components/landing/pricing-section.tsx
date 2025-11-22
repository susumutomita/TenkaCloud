'use client';

import { motion } from 'framer-motion';
import { Check, Zap } from 'lucide-react';
import Link from 'next/link';

const plans = [
  {
    name: 'Free',
    description: '個人開発者や小規模イベント向け',
    price: '¥0',
    period: '/月',
    features: [
      '最大100参加者',
      'Pool モデル (共有リソース)',
      '基本的な問題管理',
      'コミュニティサポート',
      '1テナント',
    ],
    cta: '無料で始める',
    highlighted: false,
  },
  {
    name: 'Pro',
    description: '成長企業や定期開催イベント向け',
    price: '¥9,800',
    period: '/月',
    features: [
      '最大1,000参加者',
      'Silo モデル (専用リソース)',
      '高度な分析・ダッシュボード',
      '優先サポート (24時間以内)',
      'カスタムドメイン',
      '無制限テナント',
    ],
    cta: 'Pro を始める',
    highlighted: true,
  },
  {
    name: 'Enterprise',
    description: '大規模イベントやエンタープライズ向け',
    price: 'お問い合わせ',
    period: '',
    features: [
      '無制限参加者',
      '専用インフラ',
      'SLA 保証 (99.9%)',
      '専任サポート',
      'オンプレミス対応',
      'カスタム統合',
    ],
    cta: 'お問い合わせ',
    highlighted: false,
  },
];

export function PricingSection() {
  return (
    <section
      id="pricing"
      className="section-padding bg-gradient-to-b from-transparent to-black/20"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center space-y-4 mb-16"
        >
          <h2 className="text-5xl sm:text-6xl font-bold gradient-text">
            シンプルな料金プラン
          </h2>
          <p className="text-xl text-white/70 max-w-2xl mx-auto">
            必要な機能だけを、必要なときに。いつでもアップグレード・ダウングレード可能です。
          </p>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-8 max-w-6xl mx-auto">
          {plans.map((plan, index) => (
            <motion.div
              key={plan.name}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: index * 0.1 }}
              className="relative"
            >
              {plan.highlighted && (
                <div className="absolute -inset-px rounded-3xl bg-gradient-to-b from-primary-500 to-accent-500 opacity-75 blur-lg" />
              )}

              <div
                className={`relative h-full p-8 rounded-3xl ${
                  plan.highlighted
                    ? 'glass border-primary-500/50 glow'
                    : 'glass'
                }`}
              >
                {plan.highlighted && (
                  <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                    <div className="flex items-center gap-1 px-4 py-1.5 bg-gradient-to-r from-primary-500 to-accent-500 rounded-full text-sm font-semibold">
                      <Zap className="w-4 h-4" />
                      人気
                    </div>
                  </div>
                )}

                <div className="space-y-6">
                  <div>
                    <h3 className="text-2xl font-bold text-white">
                      {plan.name}
                    </h3>
                    <p className="text-white/60 mt-2">{plan.description}</p>
                  </div>

                  <div className="flex items-baseline gap-1">
                    <span className="text-5xl font-bold text-white">
                      {plan.price}
                    </span>
                    {plan.period && (
                      <span className="text-white/60">{plan.period}</span>
                    )}
                  </div>

                  <ul className="space-y-3">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-3">
                        <Check className="w-5 h-5 text-accent-400 flex-shrink-0 mt-0.5" />
                        <span className="text-white/80">{feature}</span>
                      </li>
                    ))}
                  </ul>

                  <Link href="/signup" className="block">
                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      className={`w-full py-3 px-6 rounded-xl font-semibold transition-all ${
                        plan.highlighted
                          ? 'bg-gradient-to-r from-primary-500 to-accent-500 shadow-lg shadow-primary-500/25'
                          : 'bg-white/10 hover:bg-white/15'
                      }`}
                    >
                      {plan.cta}
                    </motion.button>
                  </Link>
                </div>
              </div>
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          className="mt-12 text-center text-white/60"
        >
          <p>すべてのプランには14日間の無料トライアルが含まれます。</p>
          <p className="mt-2">クレジットカード登録不要で今すぐ始められます。</p>
        </motion.div>
      </div>
    </section>
  );
}
