'use client';

import { motion } from 'framer-motion';
import { Activity, Users, Zap } from 'lucide-react';

export default function DashboardPage() {
  return (
    <div className="min-h-screen p-8">
      <div className="max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-8"
        >
          {/* Header */}
          <div>
            <h1 className="text-4xl font-bold gradient-text mb-2">
              ダッシュボード
            </h1>
            <p className="text-white/60">
              テナントが正常に作成されました。管理を開始しましょう。
            </p>
          </div>

          {/* Stats cards */}
          <div className="grid md:grid-cols-3 gap-6">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="glass rounded-2xl p-6"
            >
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-gradient-to-br from-primary-500 to-accent-500 rounded-xl flex items-center justify-center">
                  <Users className="w-6 h-6 text-white" />
                </div>
                <div>
                  <p className="text-white/60 text-sm">参加者数</p>
                  <p className="text-3xl font-bold text-white">0</p>
                </div>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="glass rounded-2xl p-6"
            >
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-gradient-to-br from-accent-500 to-primary-500 rounded-xl flex items-center justify-center">
                  <Activity className="w-6 h-6 text-white" />
                </div>
                <div>
                  <p className="text-white/60 text-sm">アクティブコンテスト</p>
                  <p className="text-3xl font-bold text-white">0</p>
                </div>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="glass rounded-2xl p-6"
            >
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-gradient-to-br from-primary-500 to-accent-500 rounded-xl flex items-center justify-center">
                  <Zap className="w-6 h-6 text-white" />
                </div>
                <div>
                  <p className="text-white/60 text-sm">ステータス</p>
                  <p className="text-xl font-bold text-accent-400">Running</p>
                </div>
              </div>
            </motion.div>
          </div>

          {/* Quick start guide */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="glass rounded-2xl p-8"
          >
            <h2 className="text-2xl font-bold text-white mb-6">
              クイックスタートガイド
            </h2>

            <div className="space-y-4">
              <div className="flex items-start gap-4 p-4 bg-white/5 rounded-xl">
                <div className="w-8 h-8 bg-primary-500 rounded-full flex items-center justify-center flex-shrink-0">
                  <span className="text-sm font-bold">1</span>
                </div>
                <div>
                  <h3 className="font-semibold text-white mb-1">
                    最初の問題を作成
                  </h3>
                  <p className="text-white/60 text-sm">
                    問題管理画面で、最初のプログラミング問題を追加しましょう。
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4 p-4 bg-white/5 rounded-xl">
                <div className="w-8 h-8 bg-primary-500 rounded-full flex items-center justify-center flex-shrink-0">
                  <span className="text-sm font-bold">2</span>
                </div>
                <div>
                  <h3 className="font-semibold text-white mb-1">
                    コンテストを作成
                  </h3>
                  <p className="text-white/60 text-sm">
                    問題セットを組み合わせて、コンテストを作成しましょう。
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4 p-4 bg-white/5 rounded-xl">
                <div className="w-8 h-8 bg-primary-500 rounded-full flex items-center justify-center flex-shrink-0">
                  <span className="text-sm font-bold">3</span>
                </div>
                <div>
                  <h3 className="font-semibold text-white mb-1">
                    参加者を招待
                  </h3>
                  <p className="text-white/60 text-sm">
                    招待リンクを共有して、参加者を集めましょう。
                  </p>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}
