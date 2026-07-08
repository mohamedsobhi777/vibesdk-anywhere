/**
 * Enhanced Auth Context
 * Provides OAuth + Email/Password authentication via Supabase Auth
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { AuthError, type Session, type User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { useSentryUser } from '@/hooks/useSentryUser';
import type { AuthSession, AuthUser } from '../api-types';

interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  session: AuthSession | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  // Auth provider configuration
  authProviders: {
    google: boolean;
    github: boolean;
    email: boolean;
  } | null;
  hasOAuth: boolean;
  requiresEmailAuth: boolean;

  // OAuth login method with redirect support
  login: (provider: 'google' | 'github', redirectUrl?: string) => void;

  // Email/password login method
  loginWithEmail: (credentials: { email: string; password: string }) => Promise<void>;
  register: (data: { email: string; password: string; name?: string }) => Promise<void>;

  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  clearError: () => void;

  // Redirect URL management
  setIntendedUrl: (url: string) => void;
  getIntendedUrl: () => string | null;
  clearIntendedUrl: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Supabase Auth is provisioned with Google, GitHub, and email/password
// enabled for this app. The `/api/auth/providers` endpoint this used to be
// fetched from is retired, so the config is static.
const DEFAULT_AUTH_PROVIDERS: { google: boolean; github: boolean; email: boolean } = {
  google: true,
  github: true,
  email: true,
};

function readMetadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// Maps a Supabase `User` to this app's `AuthUser` shape.
function mapUser(user: User | null): AuthUser | null {
  if (!user) {
    return null;
  }

  const metadata = user.user_metadata as Record<string, unknown>;

  return {
    id: user.id,
    // OAuth (Google/GitHub) and email/password are the only sign-in methods
    // this app supports, so Supabase always populates `email`; the fallback
    // only satisfies `User.email`'s type-level optionality.
    email: user.email ?? '',
    displayName:
      readMetadataString(metadata, 'display_name') ??
      readMetadataString(metadata, 'name') ??
      readMetadataString(metadata, 'full_name'),
    avatarUrl: readMetadataString(metadata, 'avatar_url') ?? readMetadataString(metadata, 'picture'),
    provider: user.app_metadata.provider,
    emailVerified: Boolean(user.email_confirmed_at),
    createdAt: new Date(user.created_at),
    isAnonymous: false,
  };
}

// Maps a Supabase `Session` to this app's `AuthSession` shape.
function mapSession(session: Session | null): AuthSession | null {
  if (!session) {
    return null;
  }

  return {
    userId: session.user.id,
    email: session.user.email ?? '',
    sessionId: session.user.id,
    expiresAt: new Date((session.expires_at ?? 0) * 1000),
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  // Sync user context with Sentry for error tracking
  useSentryUser(user);

  // Redirect URL management
  const INTENDED_URL_KEY = 'auth_intended_url';

  const setIntendedUrl = useCallback((url: string) => {
    try {
      sessionStorage.setItem(INTENDED_URL_KEY, url);
    } catch (error) {
      console.warn('Failed to store intended URL:', error);
    }
  }, []);

  const getIntendedUrl = useCallback((): string | null => {
    try {
      return sessionStorage.getItem(INTENDED_URL_KEY);
    } catch (error) {
      console.warn('Failed to retrieve intended URL:', error);
      return null;
    }
  }, []);

  const clearIntendedUrl = useCallback(() => {
    try {
      sessionStorage.removeItem(INTENDED_URL_KEY);
    } catch (error) {
      console.warn('Failed to clear intended URL:', error);
    }
  }, []);

  // Bootstrap the current session on mount, then stay in sync with Supabase
  // Auth for the lifetime of the provider (sign-in, sign-out, token refresh
  // all flow through the same subscription).
  useEffect(() => {
    let isMounted = true;

    const bootstrapSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!isMounted) {
        return;
      }
      setUser(mapUser(session?.user ?? null));
      setToken(session?.access_token ?? null);
      setSession(mapSession(session));
      setIsLoading(false);
    };

    void bootstrapSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(mapUser(session?.user ?? null));
      setToken(session?.access_token ?? null);
      setSession(mapSession(session));
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  // OAuth login method with redirect support
  const login = useCallback((provider: 'google' | 'github', redirectUrl?: string) => {
    // Store intended redirect URL if provided, otherwise use current location
    const intendedUrl = redirectUrl ?? window.location.pathname + window.location.search;
    setIntendedUrl(intendedUrl);

    // Supabase redirects the browser to the provider and back to `redirectTo`;
    // detectSessionInUrl (on by default) then completes the session there.
    void supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}${intendedUrl}`,
      },
    });
  }, [setIntendedUrl]);

  // Email/password login
  const loginWithEmail = useCallback(async (credentials: { email: string; password: string }) => {
    setError(null);
    setIsLoading(true);

    try {
      const { error: signInError } = await supabase.auth.signInWithPassword(credentials);
      if (signInError) {
        throw signInError;
      }

      // onAuthStateChange populates user/token/session; just navigate.
      const intendedUrl = getIntendedUrl();
      clearIntendedUrl();
      navigate(intendedUrl || '/');
    } catch (error) {
      console.error('Login error:', error);
      setError(error instanceof AuthError ? error.message : 'Connection error. Please try again.');
      // Don't navigate on error - let modal stay open
      throw error; // Re-throw to inform caller
    } finally {
      setIsLoading(false);
    }
  }, [navigate, getIntendedUrl, clearIntendedUrl]);

  // Register new user
  const register = useCallback(async (data: { email: string; password: string; name?: string }) => {
    setError(null);
    setIsLoading(true);

    try {
      const { error: signUpError } = await supabase.auth.signUp({
        email: data.email,
        password: data.password,
        options: {
          data: { display_name: data.name },
        },
      });
      if (signUpError) {
        throw signUpError;
      }

      // onAuthStateChange populates user/token/session; just navigate.
      const intendedUrl = getIntendedUrl();
      clearIntendedUrl();
      navigate(intendedUrl || '/');
    } catch (error) {
      console.error('Registration error:', error);
      setError(error instanceof AuthError ? error.message : 'Connection error. Please try again.');
      throw error; // Re-throw to inform caller
    } finally {
      setIsLoading(false);
    }
  }, [navigate, getIntendedUrl, clearIntendedUrl]);

  // Logout
  const logout = useCallback(async () => {
    try {
      await supabase.auth.signOut();
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      // Clear state regardless of API response
      setUser(null);
      setToken(null);
      setSession(null);
      navigate('/');
    }
  }, [navigate]);

  // Refresh user profile
  const refreshUser = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    setUser(mapUser(session?.user ?? null));
    setToken(session?.access_token ?? null);
    setSession(mapSession(session));
  }, []);


  // Clear error
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const value: AuthContextType = {
    user,
    token,
    session,
    isAuthenticated: !!user,
    isLoading,
    error,
    authProviders: DEFAULT_AUTH_PROVIDERS,
    hasOAuth: true,
    requiresEmailAuth: true,
    login, // OAuth method with redirect support
    loginWithEmail, // Email/password method
    register,
    logout,
    refreshUser,
    clearError,
    setIntendedUrl,
    getIntendedUrl,
    clearIntendedUrl,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

// Helper hook for protected routes
export function useRequireAuth(redirectTo = '/') {
  const { isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate(redirectTo);
    }
  }, [isAuthenticated, isLoading, navigate, redirectTo]);

  return { isAuthenticated, isLoading };
}
