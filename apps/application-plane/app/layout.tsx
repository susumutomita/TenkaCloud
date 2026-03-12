import type { Metadata } from 'next';
import { auth, authSkipEnabled } from '@/auth';
import { Providers } from '@/components/providers';
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
    <html lang="ja">
      <body>
        <Providers session={session} authSkip={authSkipEnabled}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
