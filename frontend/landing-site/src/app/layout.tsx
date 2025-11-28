import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TenkaCloud - プログラミングバトルプラットフォーム",
  description:
    "プログラミングコンテストやハッカソンを5分でデプロイ。マルチテナント対応、自動スケーリング、エンタープライズグレードのセキュリティ。",
  keywords: [
    "プログラミングコンテスト",
    "ハッカソン",
    "競技プログラミング",
    "オンラインジャッジ",
    "マルチテナント",
    "SaaS",
  ],
  openGraph: {
    title: "TenkaCloud - プログラミングバトルプラットフォーム",
    description: "5分でプログラミングコンテストをデプロイ",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body className="antialiased">{children}</body>
    </html>
  );
}
