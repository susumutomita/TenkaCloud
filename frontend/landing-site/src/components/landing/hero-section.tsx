"use client";

import { motion } from "framer-motion";
import { ArrowRight, Sparkles } from "lucide-react";
import Link from "next/link";

export function HeroSection() {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
      {/* Background gradient orbs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full opacity-20 blur-3xl animate-float"
          style={{ background: "oklch(0.56 0.20 264)" }}
        />
        <div
          className="absolute bottom-1/4 right-1/4 w-96 h-96 rounded-full opacity-20 blur-3xl animate-float"
          style={{ background: "oklch(0.56 0.20 180)", animationDelay: "-3s" }}
        />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="space-y-8"
        >
          {/* Badge */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1 }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full glass border border-primary-500/30"
          >
            <Sparkles className="w-4 h-4 text-accent-400" />
            <span className="text-sm font-medium text-primary-100">
              プログラミングバトルプラットフォーム
            </span>
          </motion.div>

          {/* Heading */}
          <h1 className="text-6xl sm:text-7xl lg:text-8xl font-bold tracking-tight">
            <span className="block gradient-text">コンテストを、</span>
            <span className="block gradient-text">もっと自由に。</span>
          </h1>

          {/* Description */}
          <p className="max-w-2xl mx-auto text-xl sm:text-2xl text-white/70 leading-relaxed">
            TenkaCloud は、プログラミングコンテストやハッカソンを
            <span className="text-accent-400 font-semibold">5分でデプロイ</span>
            できるマルチテナント SaaS プラットフォームです。
          </p>

          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
            <Link href="/signup">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="group relative px-8 py-4 bg-gradient-to-r from-primary-500 to-accent-500 rounded-2xl font-semibold text-lg shadow-lg shadow-primary-500/25 hover:shadow-primary-500/40 transition-shadow"
              >
                <span className="flex items-center gap-2">
                  無料で始める
                  <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </span>
              </motion.button>
            </Link>

            <Link href="#demo">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="px-8 py-4 glass rounded-2xl font-semibold text-lg hover:border-primary-500/50 transition-colors"
              >
                デモを見る
              </motion.button>
            </Link>
          </div>

          {/* Stats */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="flex items-center justify-center gap-8 sm:gap-12 pt-12 text-sm"
          >
            <div className="text-center">
              <div className="text-3xl font-bold text-primary-400">5分</div>
              <div className="text-white/50 mt-1">デプロイ時間</div>
            </div>
            <div className="h-12 w-px bg-white/10" />
            <div className="text-center">
              <div className="text-3xl font-bold text-accent-400">100%</div>
              <div className="text-white/50 mt-1">自動化</div>
            </div>
            <div className="h-12 w-px bg-white/10" />
            <div className="text-center">
              <div className="text-3xl font-bold text-primary-400">∞</div>
              <div className="text-white/50 mt-1">スケーラビリティ</div>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
