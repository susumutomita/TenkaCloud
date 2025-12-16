'use server';

import { signIn } from '@/auth';

export async function loginWithKeycloak() {
  await signIn('keycloak', { redirectTo: '/dashboard' });
}
