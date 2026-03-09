'use server';

import { signIn } from '@/auth';

export async function signupWithAuth0() {
  await signIn('auth0', {
    redirectTo: '/onboarding',
    authorizationParams: { screen_hint: 'signup' },
  });
}
