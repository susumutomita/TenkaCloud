import type { Metadata } from 'next';
import { ThemeSync } from '@/components/theme-sync';
import { getThemeBootstrapScript } from '@/lib/theme';
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
    <html lang="ja" suppressHydrationWarning>
      <body
        className="min-h-screen bg-background text-foreground"
        suppressHydrationWarning
      >
        <script
          dangerouslySetInnerHTML={{ __html: getThemeBootstrapScript() }}
        />
        <ThemeSync />
        {children}
      </body>
    </html>
  );
}
