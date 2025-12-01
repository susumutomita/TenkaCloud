'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  Activity,
  ArrowRight,
  Calendar,
  CheckCircle2,
  ClipboardCheck,
  Settings,
  Users,
} from 'lucide-react';

const participantUrl =
  process.env.NEXT_PUBLIC_PARTICIPANT_URL || 'http://localhost:3002';

const highlight = [
  {
    label: '稼働率 (過去 24h)',
    value: '99.95%',
    icon: Activity,
    gradient: 'from-emerald-500 to-teal-500',
  },
  {
    label: '未処理の申請',
    value: '3 件',
    icon: ClipboardCheck,
    gradient: 'from-amber-500 to-orange-500',
  },
  {
    label: '今週のイベント',
    value: '5 件',
    icon: Calendar,
    gradient: 'from-purple-500 to-pink-500',
  },
];

const operationChecklist = [
  'Keycloak Realm とクライアント設定を確認し、管理者ロールが最新であることをチェック',
  'バトル用の問題セットが最新リリースと一致しているか検証し、プレビューでレンダリングを確認',
  '監査ログの転送先が到達可能であることを確認',
  '重大インシデントのエスカレーション先が有効か定期テストを実施',
];

export default function Home() {
  const container = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1,
      },
    },
  };

  const item = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0 },
  };

  return (
    <div className="min-h-screen p-8 relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden -z-10 pointer-events-none">
        <div className="absolute top-[-10%] right-[-5%] w-[500px] h-[500px] bg-primary-500/20 rounded-full blur-[100px]" />
        <div className="absolute bottom-[-10%] left-[-5%] w-[500px] h-[500px] bg-accent-500/20 rounded-full blur-[100px]" />
      </div>

      <div className="max-w-7xl mx-auto">
        <motion.div
          variants={container}
          initial="hidden"
          animate="show"
          className="space-y-10"
        >
          {/* Header */}
          <motion.div variants={item} className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm uppercase tracking-wider text-white/50 mb-1">
                  Admin Console
                </p>
                <h1 className="text-4xl md:text-5xl font-bold gradient-text">
                  TenkaCloud Admin
                </h1>
                <p className="mt-3 text-lg text-white/60 max-w-2xl">
                  テナント管理者向けの運用ダッシュボードです。認証は Keycloak
                  で保護され、実データはバックエンド接続後に読み込まれます。
                </p>
              </div>
              <div className="flex gap-3">
                <Link href="/docs/architecture">
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    className="px-5 py-2.5 glass rounded-xl font-medium text-white/80 hover:text-white transition-colors"
                  >
                    アーキテクチャ
                  </motion.button>
                </Link>
                <Link href="/events">
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    className="px-5 py-2.5 bg-gradient-to-r from-primary-500 to-accent-500 rounded-xl font-semibold shadow-lg shadow-primary-500/25 hover:shadow-primary-500/40 transition-shadow"
                  >
                    イベント管理
                  </motion.button>
                </Link>
              </div>
            </div>
          </motion.div>

          {/* Stats Cards */}
          <motion.div variants={item} className="grid md:grid-cols-3 gap-6">
            {highlight.map((stat) => (
              <div
                key={stat.label}
                className="group relative p-1 rounded-2xl bg-gradient-to-br from-white/10 to-white/5 hover:from-white/20 hover:to-white/10 transition-all duration-300 border border-white/10"
              >
                <div className="relative p-6 flex items-center gap-5">
                  <div
                    className={`w-14 h-14 rounded-xl bg-gradient-to-br ${stat.gradient} flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform duration-300`}
                  >
                    <stat.icon className="w-6 h-6 text-white" />
                  </div>
                  <div>
                    <p className="text-white/60 text-sm font-medium mb-1">
                      {stat.label}
                    </p>
                    <p className="text-3xl font-bold text-white tracking-tight">
                      {stat.value}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </motion.div>

          {/* Main Content */}
          <motion.div variants={item} className="grid md:grid-cols-3 gap-6">
            {/* Operations Checklist */}
            <div className="md:col-span-2 glass rounded-2xl p-6">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-xl font-bold text-white">
                    運用チェックリスト
                  </h2>
                  <p className="text-sm text-white/50 mt-1">
                    日常的な運用タスクの確認事項
                  </p>
                </div>
                <span className="px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                  安定稼働中
                </span>
              </div>
              <ul className="space-y-4">
                {operationChecklist.map((task, index) => (
                  <li key={index} className="flex items-start gap-3">
                    <CheckCircle2 className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
                    <span className="text-sm text-white/80">{task}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Quick Links */}
            <div className="glass rounded-2xl p-6">
              <div className="mb-6">
                <h2 className="text-xl font-bold text-white">クイックリンク</h2>
                <p className="text-sm text-white/50 mt-1">
                  よく使う機能へのショートカット
                </p>
              </div>
              <div className="space-y-3">
                <a href={participantUrl}>
                  <motion.div
                    whileHover={{ scale: 1.02 }}
                    className="flex items-center justify-between p-4 bg-white/5 hover:bg-white/10 rounded-xl border border-white/5 hover:border-white/20 transition-all duration-300 cursor-pointer"
                  >
                    <div className="flex items-center gap-3">
                      <Users className="w-5 h-5 text-primary-400" />
                      <span className="font-medium text-white">
                        Participant UI を開く
                      </span>
                    </div>
                    <ArrowRight className="w-4 h-4 text-white/50" />
                  </motion.div>
                </a>
                <Link href="/events">
                  <motion.div
                    whileHover={{ scale: 1.02 }}
                    className="flex items-center justify-between p-4 bg-white/5 hover:bg-white/10 rounded-xl border border-white/5 hover:border-white/20 transition-all duration-300 cursor-pointer"
                  >
                    <div className="flex items-center gap-3">
                      <Calendar className="w-5 h-5 text-accent-400" />
                      <span className="font-medium text-white">
                        イベント一覧を見る
                      </span>
                    </div>
                    <ArrowRight className="w-4 h-4 text-white/50" />
                  </motion.div>
                </Link>
                <Link href="/docs/architecture">
                  <motion.div
                    whileHover={{ scale: 1.02 }}
                    className="flex items-center justify-between p-4 bg-white/5 hover:bg-white/10 rounded-xl border border-white/5 hover:border-white/20 transition-all duration-300 cursor-pointer"
                  >
                    <div className="flex items-center gap-3">
                      <Settings className="w-5 h-5 text-white/60" />
                      <span className="font-medium text-white">
                        セットアップ手順
                      </span>
                    </div>
                    <ArrowRight className="w-4 h-4 text-white/50" />
                  </motion.div>
                </Link>
              </div>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}
