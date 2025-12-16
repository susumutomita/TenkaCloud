'use server';

import { signIn } from '@/auth';

export async function loginWithAuth0() {
  await signIn('auth0', { redirectTo: '/dashboard' });
}
