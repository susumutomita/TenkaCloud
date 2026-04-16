'use server';

import { signIn } from '@/auth';

export async function loginWithProvider() {
  await signIn('cognito', { redirectTo: '/dashboard' });
}

/** @deprecated Use loginWithProvider instead */
export const loginWithAuth0 = loginWithProvider;
