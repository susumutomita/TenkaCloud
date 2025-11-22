import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TenkaCloud - Admin Portal',
  description: 'テナント管理者用ダッシュボード',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
