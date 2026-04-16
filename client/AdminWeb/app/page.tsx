import { redirect } from 'next/navigation';
import { getSession } from '@/auth';

export default async function HomePage() {
  const session = await getSession();

  // 認証済みユーザーはダッシュボードへ、未認証ユーザーはログインページへ
  if (session?.user) {
    redirect('/dashboard');
  }

  redirect('/login');
}
