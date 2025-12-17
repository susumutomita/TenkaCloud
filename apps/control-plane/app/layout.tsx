import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TenkaCloud Control Plane',
  description: 'プラットフォーム管理者向けコンソール',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
