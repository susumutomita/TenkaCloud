import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TenkaCloud - Battle Arena',
  description: 'クラウド天下一武道会 - 競技者用UI',
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
