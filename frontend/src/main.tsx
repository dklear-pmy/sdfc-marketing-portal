import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider, Navigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AuthProvider,
  LandingRedirect,
  RequireAdmin,
  RequireAuth,
  RequireSection,
} from '@/lib/auth';
import AppLayout from '@/routes/AppLayout';
import Login from '@/routes/Login';
import Harness from '@/routes/Harness';
import Fans from '@/routes/Fans';
import FanLedger from '@/routes/FanLedger';
import Tripwires from '@/routes/Tripwires';

// Stadium pulls in MapLibre GL (~250 KB gzip) — split it out of the main bundle.
const Stadium = lazy(() => import('@/routes/Stadium'));
import Admin from '@/routes/Admin';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <LandingRedirect /> },
      {
        path: 'harness',
        element: (
          <RequireSection section="marketing">
            <Harness />
          </RequireSection>
        ),
      },
      {
        path: 'fans',
        element: (
          <RequireSection section="fans">
            <Fans />
          </RequireSection>
        ),
      },
      {
        path: 'ledger',
        element: (
          <RequireSection section="fans">
            <FanLedger />
          </RequireSection>
        ),
      },
      { path: 'customers', element: <Navigate to="/fans" replace /> },
      {
        path: 'stadium',
        element: (
          <RequireSection section="stadium">
            <Suspense fallback={null}>
              <Stadium />
            </Suspense>
          </RequireSection>
        ),
      },
      {
        path: 'tripwires',
        element: (
          <RequireSection section="marketing">
            <Tripwires />
          </RequireSection>
        ),
      },
      {
        path: 'admin',
        element: (
          <RequireAdmin>
            <Admin />
          </RequireAdmin>
        ),
      },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AuthProvider>
  </StrictMode>
);
