'use client';

import { motion } from 'framer-motion';
import {
  Activity,
  Users,
  Zap,
  ArrowRight,
  Code,
  Trophy,
  UserPlus,
} from 'lucide-react';
import Link from 'next/link';

const ADMIN_URL = process.env.NEXT_PUBLIC_ADMIN_URL || 'http://localhost:3001';

export default function DashboardPage() {
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
          <motion.div variants={item} className="space-y-2">
            <h1 className="text-4xl md:text-5xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white via-white to-white/70">
              ダッシュボード
            </h1>
            <p className="text-lg text-white/60 max-w-2xl">
              テナントのセットアップが完了しました。以下のガイドに従って、コンテストの準備を始めましょう。
            </p>
          </motion.div>

          {/* Stats cards */}
          <motion.div variants={item} className="grid md:grid-cols-3 gap-6">
            <StatsCard
              icon={<Users className="w-6 h-6 text-white" />}
              label="参加者数"
              value="0"
              gradient="from-blue-500 to-cyan-500"
            />
            <StatsCard
              icon={<Trophy className="w-6 h-6 text-white" />}
              label="アクティブコンテスト"
              value="0"
              gradient="from-purple-500 to-pink-500"
            />
            <StatsCard
              icon={<Activity className="w-6 h-6 text-white" />}
              label="システムステータス"
              value="Running"
              valueColor="text-emerald-400"
              gradient="from-emerald-500 to-teal-500"
            />
          </motion.div>

          {/* Quick start guide */}
          <motion.div variants={item} className="space-y-6">
            <h2 className="text-2xl font-bold text-white flex items-center gap-2">
              <Zap className="w-6 h-6 text-yellow-400" />
              クイックスタート
            </h2>

            <div className="grid gap-4">
              <QuickStartItem
                number="1"
                title="最初の問題を作成"
                description="Admin Appの問題管理画面へ移動し、プログラミング問題を追加します。"
                icon={<Code className="w-5 h-5" />}
                href={`${ADMIN_URL}/problems/new`}
              />
              <QuickStartItem
                number="2"
                title="コンテストを作成"
                description="作成した問題を組み合わせて、新しいコンテストを開催します。"
                icon={<Trophy className="w-5 h-5" />}
                href={`${ADMIN_URL}/contests/new`}
              />
              <QuickStartItem
                number="3"
                title="参加者を招待"
                description="招待リンクを発行して、参加者に共有しましょう。"
                icon={<UserPlus className="w-5 h-5" />}
                href={`${ADMIN_URL}/users/invite`}
              />
            </div>
          </motion.div>

          {/* Admin Console Link */}
          <motion.div variants={item} className="flex justify-center pt-8">
            <a
              href={ADMIN_URL}
              className="group relative inline-flex items-center gap-2 px-8 py-4 bg-white/10 hover:bg-white/20 border border-white/10 rounded-full transition-all duration-300 backdrop-blur-md"
            >
              <span className="font-semibold text-white">
                管理コンソール (Admin App) を開く
              </span>
              <ArrowRight className="w-5 h-5 text-white group-hover:translate-x-1 transition-transform" />
            </a>
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}

function StatsCard({
  icon,
  label,
  value,
  gradient,
  valueColor = 'text-white',
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  gradient: string;
  valueColor?: string;
}) {
  return (
    <div className="group relative p-1 rounded-2xl bg-gradient-to-br from-white/10 to-white/5 hover:from-white/20 hover:to-white/10 transition-all duration-300 border border-white/10">
      <div className="absolute inset-0 bg-gradient-to-br opacity-0 group-hover:opacity-10 transition-opacity duration-500 rounded-2xl" />
      <div className="relative p-6 flex items-center gap-5">
        <div
          className={`w-14 h-14 rounded-xl bg-gradient-to-br ${gradient} flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform duration-300`}
        >
          {icon}
        </div>
        <div>
          <p className="text-white/60 text-sm font-medium mb-1">{label}</p>
          <p className={`text-3xl font-bold ${valueColor} tracking-tight`}>
            {value}
          </p>
        </div>
      </div>
    </div>
  );
}

function QuickStartItem({
  number,
  title,
  description,
  icon,
  href,
}: {
  number: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  href: string;
}) {
  return (
    <a
      href={href}
      className="group block relative p-6 rounded-xl bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/20 transition-all duration-300"
    >
      <div className="flex items-center gap-6">
        <div className="flex-shrink-0 w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-white font-bold group-hover:bg-primary-500 group-hover:scale-110 transition-all duration-300">
          {number}
        </div>
        <div className="flex-grow">
          <h3 className="text-lg font-semibold text-white group-hover:text-primary-400 transition-colors flex items-center gap-2">
            {title}
            <ArrowRight className="w-4 h-4 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300" />
          </h3>
          <p className="text-white/60 text-sm mt-1 group-hover:text-white/80 transition-colors">
            {description}
          </p>
        </div>
        <div className="flex-shrink-0 opacity-50 group-hover:opacity-100 transition-opacity">
          <div className="p-2 rounded-lg bg-white/5 group-hover:bg-white/10">
            {icon}
          </div>
        </div>
      </div>
    </a>
  );
}
