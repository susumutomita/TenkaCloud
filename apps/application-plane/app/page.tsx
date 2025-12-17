'use client';

import { motion } from 'framer-motion';
import { Eye, Swords, Trophy, Users, Zap } from 'lucide-react';

// 統計情報は API 接続後に動的に取得予定
const stats = [
  { label: 'Status', value: '---', icon: Zap },
  { label: 'Participants', value: '---', icon: Users },
  { label: 'Problems', value: '---', icon: Trophy },
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
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden -z-10 pointer-events-none">
        <div className="absolute top-[-20%] right-[-10%] w-[600px] h-[600px] bg-primary-500/30 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-20%] left-[-10%] w-[600px] h-[600px] bg-accent-500/30 rounded-full blur-[120px]" />
      </div>

      <motion.main
        variants={container}
        initial="hidden"
        animate="show"
        className="text-center max-w-2xl w-full glass rounded-3xl p-12"
      >
        <motion.div variants={item}>
          <h1 className="text-5xl md:text-6xl font-black mb-4 gradient-text">
            TenkaCloud
          </h1>
          <p className="text-2xl text-white/90 mb-2 font-light">
            クラウド天下一武道会
          </p>
          <p className="text-white/50 mb-12">
            最強のクラウドエンジニアを目指せ
          </p>
        </motion.div>

        <motion.div variants={item} className="space-y-4">
          <motion.button
            type="button"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="w-full bg-gradient-to-r from-primary-500 to-accent-500 text-white font-bold py-4 px-8 rounded-xl text-lg shadow-lg shadow-primary-500/25 hover:shadow-primary-500/40 transition-shadow flex items-center justify-center gap-3"
          >
            <Swords className="w-5 h-5" />
            バトルに参加する
          </motion.button>
          <motion.button
            type="button"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="w-full bg-white/5 hover:bg-white/10 text-white font-semibold py-4 px-8 rounded-xl text-lg transition-all border border-white/10 hover:border-white/20 flex items-center justify-center gap-3"
          >
            <Eye className="w-5 h-5" />
            観戦モード
          </motion.button>
        </motion.div>

        <motion.div
          variants={item}
          className="mt-12 grid grid-cols-3 gap-4 text-center"
        >
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="p-4 rounded-xl bg-white/5 border border-white/5"
            >
              <stat.icon className="w-5 h-5 text-primary-400 mx-auto mb-2" />
              <div className="font-bold text-white text-xl mb-1">
                {stat.value}
              </div>
              <div className="text-white/50 text-sm">{stat.label}</div>
            </div>
          ))}
        </motion.div>
      </motion.main>
    </div>
  );
}
