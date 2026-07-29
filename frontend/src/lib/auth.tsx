import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  GoogleAuthProvider,
  onIdTokenChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import { Navigate, useLocation } from 'react-router';
import { auth } from './firebase';

export type Role = 'viewer' | 'operator' | 'admin';

interface AuthState {
  user: User | null;
  role: Role | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);

  /* First sign-in creates the account before any role is stamped, so a user
     invited moments later still holds a role-less cached token (Kevin,
     2026-07-29). One forced refresh per user picks a just-granted role up
     without waiting out the token's hour. */
  const refreshed = useRef(new Set<string>());

  useEffect(() => {
    return onIdTokenChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        let token = await u.getIdTokenResult();
        if (!token.claims.portal_role && !refreshed.current.has(u.uid)) {
          refreshed.current.add(u.uid);
          token = await u.getIdTokenResult(true);
        }
        setRole((token.claims.portal_role as Role | undefined) ?? null);
      } else {
        setRole(null);
      }
      setLoading(false);
    });
  }, []);

  const signIn = async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password);
  };

  const signInWithGoogle = async () => {
    await signInWithPopup(auth, new GoogleAuthProvider());
  };

  const signOut = () => firebaseSignOut(auth);

  return (
    <AuthContext.Provider value={{ user, role, loading, signIn, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, role, loading, signOut } = useAuth();
  const location = useLocation();

  if (loading) return null;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  if (!role)
    return (
      <div className="flex min-h-svh items-center justify-center p-8 text-center">
        <div>
          <h1 className="text-lg font-semibold">Not authorized</h1>
          <p className="mt-2 max-w-md text-sm text-muted-foreground">
            Your account exists but has no access role yet. If access was just granted, sign out and
            back in to pick it up — otherwise ask an admin for an invite.
          </p>
          <button
            className="mt-4 rounded-lg border px-3 py-1.5 text-sm hover:bg-accent"
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
      </div>
    );
  return children;
}
