import type { Metadata } from 'next';
import { auth, authSkipEnabled } from '@/auth';
import { Providers } from '@/components/providers';
import { I18nProvider } from '@/lib/i18n';
import '@cloudscape-design/global-styles/index.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'TenkaCloud - Battle Arena',
  description: 'クラウド天下一武道会 - 競技者用UI',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await auth();

  return (
    <html lang="ja" className="awsui-dark-mode">
      <body className="awsui-dark-mode">
        <Providers session={session} authSkip={authSkipEnabled}>
          <I18nProvider>{children}</I18nProvider>
        </Providers>
      </body>
    </html>
  );
}
