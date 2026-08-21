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

/* Claim values stay lowercase; every user-facing rendering uses these. */
export const ROLE_LABELS: Record<Role, string> = {
  viewer: 'Viewer',
  operator: 'Operator',
  admin: 'Admin',
};

export type Section = 'marketing' | 'fans' | 'stadium';
export const SECTIONS: readonly Section[] = ['marketing', 'fans', 'stadium'];
export const SECTION_LABELS: Record<Section, string> = {
  marketing: 'Marketing tools',
  fans: 'Fan data',
  stadium: 'Stadium',
};

/* Mirrors the API's resolve_sections: admins hold everything, and a MISSING
   claim also grants everything — pre-sections accounts were invited when
   access was all-or-nothing. An explicit list (even []) is authoritative. */
function resolveSections(role: Role | null, claim: unknown): Section[] {
  if (!role) return [];
  if (role === 'admin' || claim == null) return [...SECTIONS];
  if (!Array.isArray(claim)) return [];
  return SECTIONS.filter((s) => (claim as unknown[]).includes(s));
}

interface AuthState {
  user: User | null;
  role: Role | null;
  sections: Section[];
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
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
        const nextRole = (token.claims.portal_role as Role | undefined) ?? null;
        setRole(nextRole);
        setSections(resolveSections(nextRole, token.claims.portal_sections));
      } else {
        setRole(null);
        setSections([]);
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
    <AuthContext.Provider
      value={{ user, role, sections, loading, signIn, signInWithGoogle, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/* Per-section route guard. Sits INSIDE RequireAuth, so user+role exist here;
   this only decides whether this signed-in user may see this area. */
export function RequireSection({ section, children }: { section: Section; children: ReactNode }) {
  const { sections } = useAuth();
  if (!sections.includes(section))
    return (
      <div className="flex min-h-[60svh] items-center justify-center p-8 text-center">
        <div>
          <h1 className="text-lg font-semibold">No access to {SECTION_LABELS[section]}</h1>
          <p className="mt-2 max-w-md text-sm text-muted-foreground">
            Your account has portal access but not this section. Ask an admin to grant{' '}
            {SECTION_LABELS[section]} — if it was just granted, sign out and back in to pick it up.
          </p>
        </div>
      </div>
    );
  return children;
}

/* "/" lands on the first section this user can actually see. */
const SECTION_HOME: Record<Section, string> = {
  // Trigger Manager is the marketing landing since 2026-08-21 — the harness
  // (Campaign Tester) is parked behind the sidebar's "More".
  marketing: '/triggers',
  fans: '/fans',
  stadium: '/stadium',
};

export function LandingRedirect() {
  const { sections, role } = useAuth();
  const first = SECTIONS.find((s) => sections.includes(s));
  if (first) return <Navigate to={SECTION_HOME[first]} replace />;
  if (role === 'admin') return <Navigate to="/admin" replace />;
  return (
    <div className="flex min-h-[60svh] items-center justify-center p-8 text-center">
      <div>
        <h1 className="text-lg font-semibold">No sections granted</h1>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          Your account has portal access but no sections yet. Ask an admin to grant one — if that
          just happened, sign out and back in to pick it up.
        </p>
      </div>
    </div>
  );
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { role } = useAuth();
  if (role !== 'admin')
    return (
      <div className="flex min-h-[60svh] items-center justify-center p-8 text-center">
        <div>
          <h1 className="text-lg font-semibold">Admins only</h1>
          <p className="mt-2 max-w-md text-sm text-muted-foreground">
            Invites, roles, and alert recipients are managed by portal admins.
          </p>
        </div>
      </div>
    );
  return children;
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
