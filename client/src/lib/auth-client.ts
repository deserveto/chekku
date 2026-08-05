import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient();
export const useSession = authClient.useSession;
export const signIn = authClient.signIn;
export const signUp = authClient.signUp;
export const signOut = authClient.signOut;
export const sendVerificationEmail = authClient.sendVerificationEmail;
